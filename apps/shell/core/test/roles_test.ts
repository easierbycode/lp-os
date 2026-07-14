import { assert, assertEquals } from "@std/assert";
import {
  applyRolesConfig,
  DEFAULT_USER_ID,
  getRole,
  getUser,
  parseRolesConfig,
  rbacClientConfig,
  resolveFlag,
  roleHasFlag,
  snapshotRolesConfig,
  userRole,
} from "../roles.ts";

Deno.test("users resolve to their functional roles", () => {
  assertEquals(DEFAULT_USER_ID, "dj");
  assertEquals(getUser("dj")?.role, "admin");
  assertEquals(getUser("ka")?.role, "warehouse");
  assertEquals(getUser("@boosteddealsdaily")?.role, "creator");
  assertEquals(userRole("ka")?.id, "warehouse");
  assertEquals(userRole("nobody"), null);
});

Deno.test("flag precedence: explicit > wildcard > deny", () => {
  assertEquals(
    resolveFlag({ "*": true, "app.graylog": false }, "app.graylog"),
    false,
  );
  assertEquals(resolveFlag({ "*": true }, "anything"), true);
  assertEquals(resolveFlag({}, "anything"), false);
  // Warehouse: explicit grants + explicit denies, no wildcard.
  assert(roleHasFlag("warehouse", "app.kiosk"));
  assert(!roleHasFlag("warehouse", "app.graylog"));
  assert(!roleHasFlag("warehouse", "some.unknown.flag"));
  // Admin wildcard grants everything; unknown role denies everything.
  assert(roleHasFlag("admin", "some.unknown.flag"));
  assert(!roleHasFlag("ghost", "app.kiosk"));
});

Deno.test("warehouse default_home carries the cleared_to_sell query", () => {
  const home = getRole("warehouse")?.default_home ?? [];
  assertEquals(home, [
    ["Apps/Inventory?status=cleared_to_sell", "left"],
    ["Apps/Kiosk", "right"],
  ]);
});

Deno.test("rbacClientConfig resolves currentUser with fallback", () => {
  const cfg = rbacClientConfig("ka");
  assertEquals(cfg.currentUser, { id: "ka", name: "Karl", role: "warehouse" });
  assertEquals(cfg.defaultUser, "dj");
  assertEquals(cfg.users.length, 3);
  assertEquals(cfg.roles.length, 3);
  // Unknown user falls back to the configured default.
  assertEquals(rbacClientConfig("nobody").currentUser.id, "dj");
});

Deno.test("the admin capability flag is declared", () => {
  const cfg = rbacClientConfig("dj");
  assert(cfg.flags.some((f) => f.id === "app.admin"));
  // Admin holds it via the wildcard; other roles don't list it, so it's denied.
  assert(roleHasFlag("admin", "app.admin"));
  assert(!roleHasFlag("warehouse", "app.admin"));
  assert(!roleHasFlag("creator", "app.admin"));
});

Deno.test("parseRolesConfig accepts a well-formed config and normalizes it", () => {
  const parsed = parseRolesConfig({
    defaultUser: "missing", // not a real user → falls back to first user
    flags: [{ id: "app.x", label: "X" }, { id: "app.y" }], // y: label defaults to id
    roles: [
      { id: "admin", name: "Admin", flags: { "*": true, junk: "nope" } },
      {
        id: "warehouse",
        flags: {},
        default_home: [["Apps/Kiosk", "left"], ["", "right"]],
      },
    ],
    users: [{ id: "u1", name: "One", role: "warehouse", email: "" }],
  });
  assert(parsed.ok, parsed.error);
  const c = parsed.config!;
  assertEquals(c.defaultUser, "u1"); // fell back to the only user
  assertEquals(c.flags[1], { id: "app.y", label: "app.y" });
  // Non-boolean grant dropped; role name defaults to id.
  assertEquals(c.roles[0].flags, { "*": true });
  assertEquals(c.roles[1].name, "warehouse");
  // Empty appPath entry dropped; the real one survives.
  assertEquals(c.roles[1].default_home, [["Apps/Kiosk", "left"]]);
  // Empty email is dropped, not persisted as "".
  assertEquals(c.users[0], { id: "u1", name: "One", role: "warehouse" });
});

Deno.test("parseRolesConfig rejects configs that would strand the shell", () => {
  assertEquals(parseRolesConfig(null).ok, false);
  assertEquals(parseRolesConfig({ flags: [], roles: [], users: [] }).ok, false);
  // A user pointing at a role that doesn't exist.
  assertEquals(
    parseRolesConfig({
      flags: [],
      roles: [{ id: "admin", flags: { "*": true } }],
      users: [{ id: "u1", name: "One", role: "ghost" }],
    }).ok,
    false,
  );
  // Duplicate role ids.
  assertEquals(
    parseRolesConfig({
      flags: [],
      roles: [{ id: "r", flags: {} }, { id: "r", flags: {} }],
      users: [],
    }).ok,
    false,
  );
});

Deno.test("applyRolesConfig swaps the live config (restored after)", () => {
  const original = snapshotRolesConfig();
  try {
    const parsed = parseRolesConfig({
      defaultUser: "solo",
      flags: [{ id: "app.only", label: "Only" }],
      roles: [{ id: "boss", name: "Boss", flags: { "*": true } }],
      users: [{ id: "solo", name: "Solo", role: "boss" }],
    });
    assert(parsed.ok, parsed.error);
    applyRolesConfig(parsed.config!);
    // Every reader now reflects the swapped config.
    assertEquals(getUser("solo")?.role, "boss");
    assertEquals(getRole("boss")?.name, "Boss");
    assertEquals(getUser("dj"), null);
    const cfg = rbacClientConfig("solo");
    assertEquals(cfg.defaultUser, "solo");
    assertEquals(cfg.roles.length, 1);
    assert(roleHasFlag("boss", "anything.at.all"));
  } finally {
    applyRolesConfig(original); // don't leak into the other tests
  }
});
