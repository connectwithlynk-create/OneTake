import * as SQLite from 'expo-sqlite';

/**
 * Single shared DB handle. openDatabaseAsync is memoized so every caller
 * shares one connection. The DB is a local cache: every row carries sync
 * columns (owner, updated_at, sync_status) so a Clerk/Supabase sync layer
 * can push/pull without further schema work. Clips also carry expires_at
 * (ephemeral takes) and remote_path (Supabase Storage object key).
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
  created_at INTEGER NOT NULL,
  owner TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local'
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
  created_at INTEGER NOT NULL,
  owner TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local',
  remote_path TEXT,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  owner TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS inspiration (
  id TEXT PRIMARY KEY NOT NULL,
  collection_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  thumb_color TEXT NOT NULL,
  note TEXT,
  added_at INTEGER NOT NULL,
  owner TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
CREATE INDEX IF NOT EXISTS idx_clips_expires ON clips(expires_at);
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

/** Idempotently add a column to a pre-existing DB (CREATE IF NOT EXISTS
 *  never alters an existing table). Table/column names are internal
 *  constants, never user input. */
async function addColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  def: string
) {
  const info = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${table})`
  );
  if (!info.some((c) => c.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

async function migrate(db: SQLite.SQLiteDatabase) {
  // clips
  await addColumn(db, 'clips', 'excluded', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'clips', 'owner', 'TEXT');
  await addColumn(db, 'clips', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'clips', 'sync_status', "TEXT NOT NULL DEFAULT 'local'");
  await addColumn(db, 'clips', 'remote_path', 'TEXT');
  await addColumn(db, 'clips', 'expires_at', 'INTEGER');
  // projects / collections / inspiration
  for (const t of ['projects', 'collections', 'inspiration']) {
    await addColumn(db, t, 'owner', 'TEXT');
    await addColumn(db, t, 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn(db, t, 'sync_status', "TEXT NOT NULL DEFAULT 'local'");
  }
  // Backfill updated_at so pre-existing rows have a sane sync clock.
  await db.execAsync(
    "UPDATE projects SET updated_at = created_at WHERE updated_at = 0"
  );
  await db.execAsync(
    "UPDATE clips SET updated_at = created_at WHERE updated_at = 0"
  );
  await db.execAsync(
    "UPDATE collections SET updated_at = created_at WHERE updated_at = 0"
  );
  await db.execAsync(
    "UPDATE inspiration SET updated_at = added_at WHERE updated_at = 0"
  );
}

/** First-run seed: starter inspiration collections so the section is not empty. */
async function seed(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM collections'
  );
  if (row && row.c === 0) {
    const now = Date.now();
    await db.runAsync(
      "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      'seed-hooks',
      'Punchy hooks',
      now,
      now
    );
    await db.runAsync(
      "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      'seed-calm',
      'Calm vlog',
      now,
      now
    );
  }
}
