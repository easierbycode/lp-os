// graylog_messages DDL. The canonical migration lives in packages/db/migrations;
// this mirror (CREATE … IF NOT EXISTS, safe to re-run) lets the backfill script
// and integration tests run standalone. @lp-os/graylog owns all SQL against
// this table — keep the shape in lockstep with docs/CONTRACTS.md.

// @ts-types="@types/pg"
import type { Pool } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS graylog_messages (
    id bigserial PRIMARY KEY,
    message_id text UNIQUE NOT NULL,
    "timestamp" timestamptz NOT NULL,
    source text NOT NULL,
    message text NOT NULL DEFAULT '',
    fields jsonb NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS graylog_messages_ts_idx
     ON graylog_messages ("timestamp" DESC)`,
  `CREATE INDEX IF NOT EXISTS graylog_messages_source_ts_idx
     ON graylog_messages (source, "timestamp" DESC)`,
  `CREATE INDEX IF NOT EXISTS graylog_messages_creator_ts_idx
     ON graylog_messages ((fields->>'creator'), "timestamp" DESC)`,
  `CREATE INDEX IF NOT EXISTS graylog_messages_fields_gin_idx
     ON graylog_messages USING gin (fields)`,
];

export async function ensureGraylogSchema(pool: Pool): Promise<void> {
  for (const sql of STATEMENTS) await pool.query(sql);
}
