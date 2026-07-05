import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  databaseUrlError,
  sanitizeDatabaseUrl,
  sslConfigFor,
} from "../db-url.ts";

Deno.test("sanitizeDatabaseUrl passes clean values through", () => {
  assertEquals(
    sanitizeDatabaseUrl("postgres://u:p@host/db"),
    "postgres://u:p@host/db",
  );
});

Deno.test("sanitizeDatabaseUrl repairs whitespace, quotes, and KEY= prefix", () => {
  assertEquals(
    sanitizeDatabaseUrl("  postgres://u@h/db  "),
    "postgres://u@h/db",
  );
  assertEquals(
    sanitizeDatabaseUrl('"postgres://u@h/db"'),
    "postgres://u@h/db",
  );
  assertEquals(
    sanitizeDatabaseUrl("'postgres://u@h/db'"),
    "postgres://u@h/db",
  );
  assertEquals(
    sanitizeDatabaseUrl("DATABASE_URL=postgres://u@h/db"),
    "postgres://u@h/db",
  );
  assertEquals(
    sanitizeDatabaseUrl('  DATABASE_URL = "postgres://u@h/db" '),
    "postgres://u@h/db",
  );
});

Deno.test("sanitizeDatabaseUrl returns null for unset/blank values", () => {
  assertEquals(sanitizeDatabaseUrl(null), null);
  assertEquals(sanitizeDatabaseUrl(undefined), null);
  assertEquals(sanitizeDatabaseUrl(""), null);
  assertEquals(sanitizeDatabaseUrl('  ""  '), null);
});

Deno.test("databaseUrlError accepts postgres URLs and socket paths", () => {
  assertEquals(databaseUrlError("postgres://u@h/db"), null);
  assertEquals(databaseUrlError("postgresql://u@h/db"), null);
  assertEquals(databaseUrlError("POSTGRES://u@h/db"), null);
  assertEquals(databaseUrlError("/var/run/postgresql"), null);
});

Deno.test("databaseUrlError flags malformed values with a helpful message", () => {
  const err = databaseUrlError("mysql://u@h/db");
  assertStringIncludes(err ?? "", "must start with");
  assertStringIncludes(err ?? "", '"mysql://u@h/db"');
});

Deno.test("sslConfigFor: TLS for hosted, none for localhost/sockets", () => {
  assertEquals(
    sslConfigFor("postgres://u:p@ep-x.neon.tech/db"),
    { rejectUnauthorized: false },
  );
  assertEquals(sslConfigFor("postgres://u@localhost:5432/db"), undefined);
  assertEquals(sslConfigFor("postgres://u@127.0.0.1/db"), undefined);
  assertEquals(sslConfigFor("postgres://localhost/db"), undefined);
  assertEquals(sslConfigFor("/var/run/postgresql"), undefined);
});
