// Guards the intentional duplication between migrations/*.sql (source of
// truth for fresh DBs, with provenance comments) and schema.ts (embedded
// copy used by ensureSchema at runtime): both must define the same tables,
// indexes, and seed inserts. schema.ts mirrors the UNION of every migration
// file, since migrate.ts applies them all in filename order.
import { assertEquals } from "@std/assert";
import { SCHEMA_SQL } from "../schema.ts";

function names(sql: string, re: RegExp): string[] {
  return [...sql.matchAll(re)].map((m) => m[1].toLowerCase()).sort();
}

const TABLE_RE = /create table if not exists public\.(\w+)/gi;
const INDEX_RE = /create index if not exists (\w+)/gi;
const INSERT_RE = /insert into public\.(\w+)/gi;

async function allMigrationsSql(): Promise<string> {
  const dir = new URL("../migrations/", import.meta.url);
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();
  const parts = await Promise.all(
    files.map((f) => Deno.readTextFile(new URL(f, dir))),
  );
  return parts.join("\n");
}

Deno.test("schema.ts stays in sync with migrations/*.sql", async () => {
  const migrations = await allMigrationsSql();

  assertEquals(names(SCHEMA_SQL, TABLE_RE), names(migrations, TABLE_RE));
  assertEquals(names(SCHEMA_SQL, INDEX_RE), names(migrations, INDEX_RE));
  assertEquals(names(SCHEMA_SQL, INSERT_RE), names(migrations, INSERT_RE));
});

Deno.test("consolidated schema covers every contract table and index", async () => {
  const migrations = await allMigrationsSql();
  assertEquals(names(migrations, TABLE_RE), [
    "bundles",
    "graylog_messages",
    "listings",
    "marketplace_accounts",
    "roles",
    "sample_images",
    "samples",
    "transactions",
    "users",
  ]);
  assertEquals(names(migrations, INDEX_RE), [
    "idx_bundles_qr_code",
    "idx_graylog_messages_creator",
    "idx_graylog_messages_fields",
    "idx_graylog_messages_source_timestamp",
    "idx_graylog_messages_timestamp",
    "idx_listings_marketplace_status",
    "idx_listings_sample_id",
    "idx_listings_status",
    "idx_samples_bundle_id",
    "idx_samples_qr_code",
    "idx_samples_related_upc",
    "idx_samples_sold_to",
    "idx_samples_status",
    "idx_transactions_created_at",
    "idx_transactions_sample_id",
  ]);
});
