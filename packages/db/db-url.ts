// db-url.ts — read + sanitize DATABASE_URL before it reaches `pg`.
// Ported from data-pimp core/db-url.ts.
//
// Why this exists: `pg` parses the connection string with pg-connection-string,
// which resolves the value relative to a dummy base URL `postgres://base`. So a
// value that ISN'T recognized as an absolute `postgres://` URL keeps the base's
// host — pg then tries to DNS-resolve the literal host "base" and the first
// query dies with the cryptic `getaddrinfo ENOTFOUND base`.
//
// The usual culprits are paste mistakes in the deployment env UI: a leading
// space, the value wrapped in quotes, or the whole `DATABASE_URL=…` line pasted
// as the value. sanitizeDatabaseUrl() repairs those so a stray space/quote no
// longer takes the site down; databaseUrlError() flags anything still malformed
// with a human-readable reason instead of letting it degrade to
// "ENOTFOUND base".

/**
 * Repair common DATABASE_URL paste mistakes: surrounding whitespace, a leading
 * `DATABASE_URL=` prefix, and a single layer of wrapping quotes. Returns null
 * when the value is unset or (after cleaning) blank.
 */
export function sanitizeDatabaseUrl(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let v = raw;

  // Trim, then drop an accidental `DATABASE_URL=` / `DATABASE_URL :` prefix
  // (the whole KEY=VALUE line pasted as the value), then trim again.
  v = v.trim().replace(/^DATABASE_URL\s*[=:]\s*/i, "").trim();

  // Strip ONE layer of matching wrapping quotes (e.g. "postgres://…").
  if (
    v.length >= 2 &&
    ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
  ) {
    v = v.slice(1, -1).trim();
  }

  return v || null;
}

/** Read DATABASE_URL from the environment and sanitize it. */
export function getDatabaseUrl(): string | null {
  return sanitizeDatabaseUrl(Deno.env.get("DATABASE_URL"));
}

/**
 * Validate a cleaned connection string. A pg connection string must be either
 * an absolute `postgres://`/`postgresql://` URL or a `/unix/socket` path;
 * anything else makes pg-connection-string fall back to host "base". Returns a
 * human-readable error string when invalid, or null when it looks usable.
 * (Returns a string instead of throwing so module init never crashes the
 * isolate — boot stays non-blocking; the error surfaces on first query.)
 */
export function databaseUrlError(v: string): string | null {
  if (v.startsWith("/")) return null; // unix-domain socket path
  if (/^postgres(ql)?:\/\//i.test(v)) return null;
  const head = JSON.stringify(v.slice(0, 16));
  return (
    `DATABASE_URL must start with "postgres://" or "postgresql://" ` +
    `(or be a /socket path); got a value beginning with ${head}. ` +
    `Check the deployment env for a leading space, surrounding quotes, or a ` +
    `"DATABASE_URL=" prefix. Left as-is, pg resolves host "base" ` +
    `(getaddrinfo ENOTFOUND base).`
  );
}

/**
 * TLS config for a connection string. Hosted Postgres (Neon) requires TLS; a
 * local dev database usually rejects it outright ("The server does not support
 * SSL connections"), and unix sockets never use it.
 */
export function sslConfigFor(
  url: string,
): { rejectUnauthorized: boolean } | undefined {
  if (url.startsWith("/")) return undefined;
  const isLocal =
    /@(localhost|127\.0\.0\.1)[:/]|^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)[:/]/i
      .test(url);
  return isLocal ? undefined : { rejectUnauthorized: false };
}
