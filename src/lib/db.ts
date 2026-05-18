import * as SQLite from 'expo-sqlite';

/**
 * Single shared DB handle. openDatabaseAsync is memoized so every caller
 * (screens, event handlers) shares one connection. Migrations run once.
 */
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  file_uri TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  verdict_overridden INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL,
  tag_overridden INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inspiration (
  id TEXT PRIMARY KEY NOT NULL,
  collection_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  thumb_color TEXT NOT NULL,
  note TEXT,
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
CREATE INDEX IF NOT EXISTS idx_insp_collection ON inspiration(collection_id);
`;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('onetake.db');
      await db.execAsync(SCHEMA);
      await migrate(db);
      await seed(db);
      return db;
    })();
  }
  return dbPromise;
}

/** Add columns to pre-existing databases (CREATE IF NOT EXISTS won't). */
async function migrate(db: SQLite.SQLiteDatabase) {
  const cols = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(clips)'
  );
  if (!cols.some((c) => c.name === 'excluded')) {
    await db.execAsync(
      'ALTER TABLE clips ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0'
    );
  }
}

/** First-run seed: a starter inspiration collection so the section is not empty. */
async function seed(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM collections'
  );
  if (row && row.c === 0) {
    const now = Date.now();
    await db.runAsync(
      'INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)',
      'seed-hooks',
      'Punchy hooks',
      now
    );
    await db.runAsync(
      'INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)',
      'seed-calm',
      'Calm vlog',
      now
    );
  }
}
