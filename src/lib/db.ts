import * as SQLite from 'expo-sqlite';

/**
 * Single shared DB handle. openDatabaseAsync is memoized so every caller
 * shares one connection. The DB is a local cache: every row carries sync
 * columns (owner, updated_at, sync_status) so a Clerk/Supabase sync layer
 * can push/pull without further schema work. Clips also carry expires_at
 * (ephemeral takes) and remote_path (Supabase Storage object key).
 */
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Canonical clips schema. One source of truth so SCHEMA and the
 *  self-heal rebuild can never drift. */
const CLIPS_COLUMNS = [
  'id',
  'project_id',
  'order_index',
  'file_uri',
  'duration_ms',
  'verdict',
  'verdict_overridden',
  'tag',
  'tag_overridden',
  'excluded',
  'created_at',
  'owner',
  'updated_at',
  'sync_status',
  'remote_path',
  'expires_at',
  'name',
  'meta_tags',
] as const;

const CLIPS_BODY = `
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
  expires_at INTEGER,
  name TEXT,
  meta_tags TEXT
`;

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

CREATE TABLE IF NOT EXISTS clips (${CLIPS_BODY});

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
`;

/**
 * Indexes run AFTER migrate(). idx_clips_expires references expires_at,
 * which a pre-existing clips table only gains via addColumn() in
 * migrate(). Creating it inside SCHEMA (before migrate) throws
 * "no such column: expires_at" on any DB created before that column
 * existed, aborting execAsync and breaking every getDb() caller.
 */
const INDEX_STMTS = [
  'CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_clips_expires ON clips(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_insp_collection ON inspiration(collection_id)',
];

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('onetake.db');
      await db.execAsync(SCHEMA);
      await migrate(db);
      // Self-heal: if ALTER-based migration could not bring the clips
      // table up to the canonical schema (corrupt / very old DB), rebuild
      // it without relying on ALTER. Guarantees expires_at etc. exist.
      await ensureClips(db);
      // Indexes last and each isolated: idx_clips_expires needs expires_at
      // (added by migrate). An index is only an optimization - a failing
      // one must never abort init and brick every DB-backed screen.
      for (const stmt of INDEX_STMTS) {
        try {
          await db.execAsync(stmt);
        } catch {
          /* index is non-essential */
        }
      }
      await seed(db);
      return db;
    })();
    // Never cache a rejected init. If open/migrate fails, clear the
    // memo so the next getDb() retries instead of replaying the failure
    // for the rest of the JS session (which bricks every DB-backed
    // screen until a full reload).
    dbPromise.catch(() => {
      dbPromise = null;
    });
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
  try {
    const info = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(${table})`
    );
    if (!info.some((c) => c.name === column)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  } catch {
    // One column failing must not abort the whole migration - that would
    // leave later columns (e.g. expires_at) unadded and brick every screen.
    // Each addColumn is independent and idempotent, so isolate failures.
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
  await addColumn(db, 'clips', 'name', 'TEXT');
  await addColumn(db, 'clips', 'meta_tags', 'TEXT');
  // projects / collections / inspiration
  for (const t of ['projects', 'collections', 'inspiration']) {
    await addColumn(db, t, 'owner', 'TEXT');
    await addColumn(db, t, 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn(db, t, 'sync_status', "TEXT NOT NULL DEFAULT 'local'");
  }
  // Backfill updated_at so pre-existing rows have a sane sync clock.
  // Non-essential - never let it abort init.
  try {
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
  } catch {
    /* backfill is best-effort */
  }
}

/**
 * Guarantees the clips table matches the canonical schema. If ALTER-based
 * migration could not add the required columns (a corrupt or very old DB,
 * which is what causes "no such column: expires_at"), rebuild the table
 * from scratch WITHOUT using ALTER: create a fresh table, copy whatever
 * columns the old one had, swap. Existing clip rows are preserved. If even
 * that fails, reset the clips table - it is a local cache; backed-up rows
 * re-sync, and a working app beats a bricked one.
 */
async function ensureClips(db: SQLite.SQLiteDatabase) {
  let have: string[];
  try {
    const info = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(clips)'
    );
    have = info.map((c) => c.name);
  } catch {
    have = [];
  }
  const missing = CLIPS_COLUMNS.filter((c) => !have.includes(c));
  if (missing.length === 0) return;

  const common = CLIPS_COLUMNS.filter((c) => have.includes(c)).join(', ');
  try {
    await db.execAsync('DROP TABLE IF EXISTS clips_rebuild');
    await db.execAsync(`CREATE TABLE clips_rebuild (${CLIPS_BODY})`);
    if (common) {
      await db.execAsync(
        `INSERT INTO clips_rebuild (${common}) SELECT ${common} FROM clips`
      );
    }
    await db.execAsync('DROP TABLE clips');
    await db.execAsync('ALTER TABLE clips_rebuild RENAME TO clips');
  } catch {
    // Could not preserve rows - last resort: reset the table so the app
    // works (local cache only).
    try {
      await db.execAsync('DROP TABLE IF EXISTS clips_rebuild');
      await db.execAsync('DROP TABLE IF EXISTS clips');
      await db.execAsync(`CREATE TABLE clips (${CLIPS_BODY})`);
    } catch {
      /* nothing more we can do */
    }
  }
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
