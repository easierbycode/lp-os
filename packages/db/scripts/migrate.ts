// migrate.ts — apply packages/db/migrations/*.sql in filename order against
// DATABASE_URL, recording each applied file in schema_migrations. Re-run safe:
// already-recorded files are skipped, and each pending file runs inside a
// transaction (all-or-nothing per file).
//
// Usage:  deno run -A packages/db/scripts/migrate.ts   (or `deno task migrate`)

// @deno-types="@types/pg"
import { Client } from "pg";
import { databaseUrlError, getDatabaseUrl, sslConfigFor } from "../db-url.ts";

const url = getDatabaseUrl();
if (!url) {
  console.error("migrate: DATABASE_URL is not set.");
  console.error(
    "  Set it to your Neon/Postgres connection string and re-run, e.g.:",
  );
  console.error(
    '    DATABASE_URL="postgres://user:pass@host/db" deno task migrate',
  );
  Deno.exit(1);
}
const urlErr = databaseUrlError(url);
if (urlErr) {
  console.error(`migrate: ${urlErr}`);
  Deno.exit(1);
}

const migrationsDir = new URL("../migrations/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(migrationsDir)) {
  if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
}
files.sort();

if (files.length === 0) {
  console.log("migrate: no .sql files found in packages/db/migrations.");
  Deno.exit(0);
}

const client = new Client({ connectionString: url, ssl: sslConfigFor(url) });
await client.connect();

let failed = false;
try {
  await client.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const done = await client.query(
    "SELECT filename FROM public.schema_migrations",
  );
  const applied = new Set<string>(
    done.rows.map((r) => String((r as Record<string, unknown>).filename)),
  );

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    const sql = await Deno.readTextFile(new URL(file, migrationsDir));
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO public.schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      ran++;
      console.log(`  + ${file} applied`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(
        `  ! ${file} FAILED (rolled back): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      failed = true;
      break;
    }
  }
  if (!failed) {
    console.log(
      `migrate: done — ${ran} applied, ${
        files.length - ran
      } already up to date.`,
    );
  }
} finally {
  await client.end();
}

if (failed) Deno.exit(1);
