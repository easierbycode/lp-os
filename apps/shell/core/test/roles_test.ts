import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_USER_ID,
  getRole,
  getUser,
  rbacClientConfig,
  resolveFlag,
  roleHasFlag,
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
