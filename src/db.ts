import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version` pragma.
 * Append new entries; never edit an applied one. Money is integer pence (GBP).
 */
export const MIGRATIONS: string[] = [
  `
  -- The product catalogue: plans a line can be on.
  CREATE TABLE tariffs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT,
    monthly_price_pence INTEGER NOT NULL CHECK (monthly_price_pence >= 0),
    -- Allowances. NULL means unlimited.
    minutes INTEGER CHECK (minutes >= 0),
    texts INTEGER CHECK (texts >= 0),
    data_mb INTEGER CHECK (data_mb >= 0),
    eu_roaming INTEGER NOT NULL CHECK (eu_roaming IN (0, 1)),
    international_roaming INTEGER NOT NULL CHECK (international_roaming IN (0, 1)),
    five_g_plus INTEGER NOT NULL CHECK (five_g_plus IN (0, 1)),
    -- Retired tariffs can't be sold; existing lines stay on them.
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- A line (subscription): a number on a tariff, billed to an account.
  CREATE TABLE lines (
    id TEXT PRIMARY KEY,
    msisdn TEXT NOT NULL,      -- reference into the MSISDN daemon
    account_id TEXT NOT NULL,  -- reference into the billing daemon (acc_)
    tariff_id TEXT NOT NULL REFERENCES tariffs (id),
    -- Price locked in when the line started: changing the catalogue never reprices a customer.
    monthly_price_pence INTEGER NOT NULL CHECK (monthly_price_pence >= 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'ceased')),
    started_on TEXT NOT NULL,
    ceased_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- A number is on at most one live line.
  CREATE UNIQUE INDEX lines_one_live_per_msisdn ON lines (msisdn) WHERE status = 'active';
  CREATE INDEX lines_account ON lines (account_id, status);
  CREATE INDEX lines_tariff ON lines (tariff_id, status);

  -- Transactional outbox (see src/events.ts).
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
  `,
  // line.started gained the line's allowances (billing rates usage against them). Restate every
  // existing line with its full state so consumers that saw the old events can catch up.
  `
  INSERT INTO outbox (type, data, occurred_at)
  SELECT 'line.restated',
    json_object(
      'line_id', l.id, 'account_id', l.account_id, 'msisdn', l.msisdn, 'tariff_id', t.id, 'tariff_name', t.name,
      'monthly_price_pence', l.monthly_price_pence, 'started_on', l.started_on, 'ceased_on', l.ceased_on,
      'allowances', json_object(
        'minutes', t.minutes, 'texts', t.texts, 'data_mb', t.data_mb,
        'eu_roaming', json(CASE WHEN t.eu_roaming THEN 'true' ELSE 'false' END),
        'international_roaming', json(CASE WHEN t.international_roaming THEN 'true' ELSE 'false' END),
        'five_g_plus', json(CASE WHEN t.five_g_plus THEN 'true' ELSE 'false' END)
      )
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM lines l JOIN tariffs t ON t.id = l.tariff_id
  ORDER BY l.id;
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { strict: true, create: true });

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.run(MIGRATIONS[version]!);
      db.run(`PRAGMA user_version = ${version + 1}`);
    })();
  }

  return db;
}
