/**
 * Role-based access control for LP-OS — functional roles (admin / creator /
 * warehouse) plus the users that hold them.
 *
 * `core/roles.json` is the SINGLE SOURCE OF TRUTH: adding a team member or
 * changing what they can see is a config edit, never a code change. The OS
 * shell (static/os.js) enforces the flags client-side — it filters the desktop
 * folders/apps the current user's role may open and applies that role's
 * `default_home` boot layout. The server injects the same config into the OS
 * shell as `globalThis.LPOS_RBAC` (via `rbacClientConfig`) so the browser and
 * the backend read one list.
 *
 * IMPORTANT: this is per-device UX gating, NOT a security boundary. The OS has
 * no auth/session (see static/os.js), so a user selection only decides which
 * launchers a given browser shows — it cannot protect a same-origin URL that
 * someone types directly. Treat it like a "kiosk profile", not authz.
 *
 * Flag resolution (see `roleHasFlag`): an explicit per-role value wins; a
 * wildcard `"*"` supplies the default for any flag the role doesn't list; an
 * unknown role or unlisted flag with no wildcard denies by default.
 *
 * The Admin window (static/admin.js → `POST /api/roles`) edits this config at
 * runtime: `applyRolesConfig` swaps the in-memory copy (so the next OS-shell
 * paint and `/api/roles` read reflect the change immediately) and
 * `persistRolesConfig` best-effort rewrites `roles.json` so the change survives
 * a restart. On a read-only filesystem (Deno Deploy) the disk write fails
 * softly — the edit still applies for the life of the process. This is UX
 * gating, not authz: the endpoint is no more a security boundary than the flags
 * themselves (see the module note above / static/os.js).
 */
import config from "./roles.json" with { type: "json" };

export interface FlagDef {
  id: string;
  label: string;
}

/** One `default_home` entry: ["Folder/Item[?query]", "left" | "right" | "none"]. */
export type HomeEntry = [string, string];

export interface Role {
  id: string;
  name: string;
  /** Boot layout applied generically by the OS shell (may be empty). */
  default_home: HomeEntry[];
  /** Per-flag grants; `"*": true` grants every flag not explicitly overridden. */
  flags: Record<string, boolean>;
}

export interface User {
  id: string;
  name: string;
  /** Id of the functional role this user holds (see `roles`). */
  role: string;
  /**
   * Login email of the same identity in lifepreneur-v1 (Better Auth), for
   * users that exist in both systems — e.g. `dj` ↔ daniel@lifepreneur.com.
   */
  email?: string;
}

export interface RolesConfig {
  defaultUser: string;
  flags: FlagDef[];
  roles: Role[];
  users: User[];
}

// Two-step cast: the JSON import infers narrow literal flag keys (with the
// wildcard `"*"`) and tuple-less string[][], which don't structurally match
// the declared shapes. `current` is mutable so the Admin window can swap the
// whole config at runtime (see `applyRolesConfig`); every reader below reads it
// live, so a save takes effect without a server restart.
let current: RolesConfig = config as unknown as RolesConfig;

/**
 * The configured fallback user id at boot. Frozen at module load (main.ts uses
 * it as a stable request fallback); the *live* default after an edit is read
 * from the config directly — see `rbacClientConfig`.
 */
export const DEFAULT_USER_ID: string = current.defaultUser;

/** Every known capability flag, in declaration order (live). */
export function flags(): FlagDef[] {
  return current.flags;
}

/**
 * Every known capability flag, in declaration order — the boot-time snapshot.
 * Retained for callers that captured it as a value; prefer `flags()` for a live
 * read after a possible Admin edit.
 */
export const FLAGS: FlagDef[] = current.flags;

/** All roles, in declaration order (live). */
export function listRoles(): Role[] {
  return current.roles;
}

/** All users, in declaration order (live). */
export function listUsers(): User[] {
  return current.users;
}

/** Look up a role by id, or null if it isn't configured. */
export function getRole(id: string): Role | null {
  const key = String(id ?? "").trim();
  return current.roles.find((r) => r.id === key) ?? null;
}

/** Look up a user by id, or null if it isn't configured. */
export function getUser(id: string): User | null {
  const key = String(id ?? "").trim();
  return current.users.find((u) => u.id === key) ?? null;
}

/** The functional role a user holds, or null for an unknown user/role. */
export function userRole(userId: string): Role | null {
  const user = getUser(userId);
  if (!user) return null;
  return getRole(user.role);
}

/**
 * Resolve one flag against a role's grant map. Explicit per-flag value wins;
 * otherwise a wildcard `"*"` supplies the default; otherwise (unlisted flag, no
 * wildcard) access is denied. Kept as a standalone pure fn so the precedence —
 * including "explicit `false` beats `"*": true`" — is unit-testable independent
 * of the config, and so static/os.js's `roleAllows` can mirror it exactly.
 */
export function resolveFlag(
  flags: Record<string, boolean>,
  flag: string,
): boolean {
  const explicit = flags[flag];
  if (typeof explicit === "boolean") return explicit;
  return flags["*"] === true;
}

/**
 * Does `roleId` hold `flag`? An unknown role is denied every flag; otherwise
 * the role's grant map is resolved via `resolveFlag`.
 */
export function roleHasFlag(roleId: string, flag: string): boolean {
  const role = getRole(roleId);
  if (!role) return false;
  return resolveFlag(role.flags, flag);
}

/**
 * The minimal, browser-safe view of the config injected into the OS shell as
 * `globalThis.LPOS_RBAC`. `currentUserId` is resolved to a known user (falling
 * back to the configured default, then the first user) so `currentUser` is
 * always a real `{id, name, role}` when any users exist.
 */
export function rbacClientConfig(currentUserId: string): {
  defaultUser: string;
  users: User[];
  roles: Role[];
  flags: FlagDef[];
  currentUser: { id: string; name: string; role: string };
} {
  const fallbackUser = current.defaultUser || DEFAULT_USER_ID;
  const user = getUser(currentUserId) ?? getUser(fallbackUser) ??
    current.users[0] ?? { id: fallbackUser, name: fallbackUser, role: "" };
  return {
    defaultUser: fallbackUser,
    users: current.users,
    roles: current.roles,
    flags: current.flags,
    currentUser: { id: user.id, name: user.name, role: user.role },
  };
}

/* ------------------------------------------------------------- editing -- */

/** A validated config plus any per-field problems, from `parseRolesConfig`. */
export interface ParsedRolesConfig {
  ok: boolean;
  error?: string;
  config?: RolesConfig;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate and normalize an untrusted `roles.json`-shaped payload (from the
 * Admin window's Save). Rejects anything that would strand the OS shell — a
 * config with no roles, a role with no id, a user pointing at a missing role,
 * or a `default_home` entry that isn't a `[appPath, side]` pair. Unknown extra
 * keys on entries are dropped, so the persisted file stays canonical.
 */
export function parseRolesConfig(input: unknown): ParsedRolesConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Expected a config object" };
  }
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.flags)) {
    return { ok: false, error: "flags must be an array" };
  }
  if (!Array.isArray(body.roles)) {
    return { ok: false, error: "roles must be an array" };
  }
  if (!Array.isArray(body.users)) {
    return { ok: false, error: "users must be an array" };
  }
  if (body.roles.length === 0) {
    return { ok: false, error: "at least one role is required" };
  }

  const flags: FlagDef[] = [];
  for (const raw of body.flags) {
    const id = asString((raw as Record<string, unknown>)?.id).trim();
    if (!id) return { ok: false, error: "every flag needs an id" };
    if (flags.some((f) => f.id === id)) {
      return { ok: false, error: `duplicate flag id: ${id}` };
    }
    flags.push({
      id,
      label: asString((raw as Record<string, unknown>).label).trim() || id,
    });
  }

  const roles: Role[] = [];
  for (const raw of body.roles) {
    const r = raw as Record<string, unknown>;
    const id = asString(r?.id).trim();
    if (!id) return { ok: false, error: "every role needs an id" };
    if (roles.some((x) => x.id === id)) {
      return { ok: false, error: `duplicate role id: ${id}` };
    }
    if (!r.flags || typeof r.flags !== "object" || Array.isArray(r.flags)) {
      return { ok: false, error: `role ${id}: flags must be an object` };
    }
    const roleFlags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(r.flags as Record<string, unknown>)) {
      if (typeof v === "boolean") roleFlags[k] = v; // drop non-boolean grants
    }
    const home: HomeEntry[] = [];
    const rawHome = Array.isArray(r.default_home) ? r.default_home : [];
    for (const entry of rawHome) {
      if (!Array.isArray(entry) || entry.length < 2) {
        return { ok: false, error: `role ${id}: bad default_home entry` };
      }
      const appPath = asString(entry[0]).trim();
      const side = asString(entry[1]).trim() || "none";
      if (!appPath) continue; // an empty slot is just no entry
      home.push([appPath, side]);
    }
    roles.push({
      id,
      name: asString(r.name).trim() || id,
      default_home: home,
      flags: roleFlags,
    });
  }

  const users: User[] = [];
  for (const raw of body.users) {
    const u = raw as Record<string, unknown>;
    const id = asString(u?.id).trim();
    if (!id) return { ok: false, error: "every user needs an id" };
    if (users.some((x) => x.id === id)) {
      return { ok: false, error: `duplicate user id: ${id}` };
    }
    const role = asString(u.role).trim();
    if (!roles.some((r) => r.id === role)) {
      return { ok: false, error: `user ${id}: unknown role "${role}"` };
    }
    const email = asString(u.email).trim();
    users.push({
      id,
      name: asString(u.name).trim() || id,
      role,
      ...(email ? { email } : {}),
    });
  }

  const defaultUser = asString(body.defaultUser).trim();
  return {
    ok: true,
    config: {
      defaultUser: users.some((u) => u.id === defaultUser)
        ? defaultUser
        : users[0]?.id ?? DEFAULT_USER_ID,
      flags,
      roles,
      users,
    },
  };
}

/** A deep clone of the live config — a safe baseline to restore or diff against. */
export function snapshotRolesConfig(): RolesConfig {
  return JSON.parse(JSON.stringify(current)) as RolesConfig;
}

/** Swap the live in-memory config. Readers above pick it up on their next call. */
export function applyRolesConfig(next: RolesConfig): void {
  current = next;
}

const ROLES_JSON_URL = new URL("./roles.json", import.meta.url);

/**
 * Best-effort rewrite of `roles.json` from the live config, so an Admin edit
 * outlives the process. Returns `{persisted:false, error}` (never throws) when
 * the filesystem is read-only (Deno Deploy) or `--allow-write` is absent — the
 * in-memory edit still stands for the running server.
 */
export async function persistRolesConfig(): Promise<
  { persisted: boolean; error?: string }
> {
  try {
    await Deno.writeTextFile(
      ROLES_JSON_URL,
      JSON.stringify(current, null, 2) + "\n",
    );
    return { persisted: true };
  } catch (error) {
    return {
      persisted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
