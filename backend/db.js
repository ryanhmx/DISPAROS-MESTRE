const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'blast.db');

// Create singleton DB instance
const db = new sqlite3.Database(DB_PATH);

// Promisified helpers
db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    })
  );

db.getAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );

db.allAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

// Init schema
function initSchema() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');
      db.run(`CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS channel_groups (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT DEFAULT '#6c63ff',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS channels (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        username   TEXT,
        chat_id    TEXT NOT NULL UNIQUE,
        group_id   TEXT REFERENCES channel_groups(id) ON DELETE SET NULL,
        active     INTEGER DEFAULT 1,
        verified   INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS campaigns (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        message_text      TEXT,
        image_path        TEXT,
        media             TEXT,
        buttons           TEXT,
        parse_mode        TEXT DEFAULT 'HTML',
        status            TEXT DEFAULT 'draft',
        auto_delete_hours INTEGER DEFAULT NULL,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      )`);
      // Migration: add auto_delete_hours to existing databases
      db.run(`ALTER TABLE campaigns ADD COLUMN auto_delete_hours INTEGER DEFAULT NULL`, [], () => {});
      // Migration: media holds a JSON array of { path, type: 'photo' | 'video' } (replaces image_path)
      db.run(`ALTER TABLE campaigns ADD COLUMN media TEXT`, [], () => {});
      db.run(`CREATE TABLE IF NOT EXISTS campaign_channels (
        campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
        channel_id  TEXT REFERENCES channels(id) ON DELETE CASCADE,
        PRIMARY KEY (campaign_id, channel_id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id            TEXT PRIMARY KEY,
        campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        schedule_type TEXT NOT NULL,
        run_at        TEXT,
        cron_expr     TEXT,
        status        TEXT DEFAULT 'pending',
        created_at    TEXT DEFAULT (datetime('now')),
        next_run_at   TEXT
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS courses (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT,
        channel_id          TEXT REFERENCES channels(id) ON DELETE SET NULL,
        status              TEXT DEFAULT 'draft',
        caption_template    TEXT,
        hashtag_prefix      TEXT DEFAULT '',
        send_index          INTEGER DEFAULT 1,
        pin_index           INTEGER DEFAULT 1,
        protect_content     INTEGER DEFAULT 0,
        delete_after_upload INTEGER DEFAULT 0,
        delay_seconds       INTEGER DEFAULT 3,
        signature           TEXT DEFAULT '',
        intro_msg_id        TEXT,
        index_msg_ids       TEXT,
        last_error          TEXT,
        created_at          TEXT DEFAULT (datetime('now')),
        updated_at          TEXT DEFAULT (datetime('now')),
        finished_at         TEXT
      )`);
      // One row per module header and per lesson file; kind = 'module' | 'lesson'
      db.run(`CREATE TABLE IF NOT EXISTS course_items (
        id              TEXT PRIMARY KEY,
        course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        module_key      TEXT DEFAULT '',
        rel_path        TEXT,
        title           TEXT,
        file_path       TEXT,
        file_size       INTEGER,
        media_type      TEXT,
        owned           INTEGER DEFAULT 1,
        position        INTEGER,
        module_num      INTEGER,
        num_path        TEXT,
        lesson_num      INTEGER,
        status          TEXT DEFAULT 'pending',
        telegram_msg_id TEXT,
        error_msg       TEXT,
        sent_at         TEXT
      )`);
      // Migrations for databases created before nested folders and signatures
      db.run(`ALTER TABLE courses ADD COLUMN signature TEXT DEFAULT ''`, [], () => {});
      db.run(`ALTER TABLE course_items ADD COLUMN num_path TEXT`, [], () => {});
      db.run(`CREATE INDEX IF NOT EXISTS idx_course_items_course ON course_items(course_id, position)`);
      db.run(`CREATE TABLE IF NOT EXISTS send_log (
        id              TEXT PRIMARY KEY,
        job_id          TEXT,
        campaign_id     TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        channel_name    TEXT,
        status          TEXT NOT NULL,
        error_msg       TEXT,
        sent_at         TEXT DEFAULT (datetime('now')),
        telegram_msg_id TEXT
      )`, [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

module.exports = { db, initSchema };
