// Guards the intentional duplication between migrations/0001_init.sql (source
// of truth for fresh DBs, with provenance comments) and schema.ts (embedded
// copy used by ensureSchema at runtime): both must define the same tables,
// indexes, and seed inserts.
import { assertEquals } from "@std/assert";
import { SCHEMA_SQL } from "../schema.ts";

function names(sql: string, re: RegExp): string[] {
  return [...sql.matchAll(re)].map((m) => m[1].toLowerCase()).sort();
}

const TABLE_RE = /create table if not exists public\.(\w+)/gi;
const INDEX_RE = /create index if not exists (\w+)/gi;
const INSERT_RE = /insert into public\.(\w+)/gi;

Deno.test("schema.ts stays in sync with migrations/0001_init.sql", async () => {
  const migration = await Deno.readTextFile(
    new URL("../migrations/0001_init.sql", import.meta.url),
  );

  assertEquals(names(SCHEMA_SQL, TABLE_RE), names(migration, TABLE_RE));
  assertEquals(names(SCHEMA_SQL, INDEX_RE), names(migration, INDEX_RE));
  assertEquals(names(SCHEMA_SQL, INSERT_RE), names(migration, INSERT_RE));
});

Deno.test("consolidated schema covers every contract table and index", async () => {
  const migration = await Deno.readTextFile(
    new URL("../migrations/0001_init.sql", import.meta.url),
  );
  assertEquals(names(migration, TABLE_RE), [
    "bundles",
    "graylog_messages",
    "roles",
    "sample_images",
    "samples",
    "transactions",
    "users",
  ]);
  assertEquals(names(migration, INDEX_RE), [
    "idx_bundles_qr_code",
    "idx_graylog_messages_creator",
    "idx_graylog_messages_fields",
    "idx_graylog_messages_source_timestamp",
    "idx_graylog_messages_timestamp",
    "idx_samples_bundle_id",
    "idx_samples_qr_code",
    "idx_samples_related_upc",
    "idx_samples_sold_to",
    "idx_samples_status",
    "idx_transactions_created_at",
    "idx_transactions_sample_id",
  ]);
});
