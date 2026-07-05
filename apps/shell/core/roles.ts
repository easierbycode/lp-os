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
// the declared shapes.
const CONFIG = config as unknown as RolesConfig;

/** The configured fallback user id (used when a stored user is unknown). */
export const DEFAULT_USER_ID: string = CONFIG.defaultUser;

/** Every known capability flag, in declaration order. */
export const FLAGS: FlagDef[] = CONFIG.flags;

/** All roles, in declaration order. */
export function listRoles(): Role[] {
  return CONFIG.roles;
}

/** All users, in declaration order. */
export function listUsers(): User[] {
  return CONFIG.users;
}

/** Look up a role by id, or null if it isn't configured. */
export function getRole(id: string): Role | null {
  const key = String(id ?? "").trim();
  return CONFIG.roles.find((r) => r.id === key) ?? null;
}

/** Look up a user by id, or null if it isn't configured. */
export function getUser(id: string): User | null {
  const key = String(id ?? "").trim();
  return CONFIG.users.find((u) => u.id === key) ?? null;
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
  const user = getUser(currentUserId) ?? getUser(DEFAULT_USER_ID) ??
    CONFIG.users[0] ?? { id: DEFAULT_USER_ID, name: DEFAULT_USER_ID, role: "" };
  return {
    defaultUser: DEFAULT_USER_ID,
    users: CONFIG.users,
    roles: CONFIG.roles,
    flags: FLAGS,
    currentUser: { id: user.id, name: user.name, role: user.role },
  };
}
