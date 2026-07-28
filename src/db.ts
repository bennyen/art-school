import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.js";

export const db = new DatabaseSync(path.join(config.dataPath, "artschool.db"));
db.exec("PRAGMA journal_mode = WAL");

/** Runs fn inside a transaction */
export function transaction(fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT,
  rel_path   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ready',
  banner     TEXT,
  sort_title TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL,
  section       TEXT,
  section_order INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  duration      REAL
);

CREATE TABLE IF NOT EXISTS materials (
  id        TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  size      INTEGER
);

CREATE TABLE IF NOT EXISTS subtitles (
  id        TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  lang      TEXT NOT NULL,
  rel_path  TEXT NOT NULL
);

-- User-edited metadata: like progress, it is NEVER wiped on rescan.
-- NULL fields fall back to the value derived from the folder name; banner is a
-- custom image (uploaded file or a frame picked from a lesson).
CREATE TABLE IF NOT EXISTS course_meta (
  course_id TEXT PRIMARY KEY,
  title     TEXT,
  category  TEXT,
  teacher     TEXT,
  banner      BLOB,
  banner_mime TEXT
);

-- Per-lesson thumbnail (small JPEG, generated on demand)
CREATE TABLE IF NOT EXISTS lesson_thumbs (
  lesson_id TEXT PRIMARY KEY,
  img       BLOB NOT NULL
);

-- Trickplay: timeline hover preview (heavily compressed JPEG sprite sheets).
-- frames = 0 flags "failed/unavailable" so it is not retried on every boot.
CREATE TABLE IF NOT EXISTS trickplay (
  lesson_id  TEXT PRIMARY KEY,
  interval   REAL NOT NULL,
  tile_w     INTEGER NOT NULL,
  tile_h     INTEGER NOT NULL,
  tile_cols  INTEGER NOT NULL,
  tile_rows  INTEGER NOT NULL,
  frames     INTEGER NOT NULL,
  sheets     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trickplay_sheets (
  lesson_id TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  img       BLOB NOT NULL,
  PRIMARY KEY (lesson_id, idx)
);

-- Progress is persistent: never wiped on rescan.
-- lesson_id = hash of the relative path, so it survives moving the library
-- to another machine or mount point.
CREATE TABLE IF NOT EXISTS progress (
  lesson_id    TEXT PRIMARY KEY,
  position_sec REAL NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

-- User notes: like progress, they are NEVER wiped on rescan.
-- lesson_id/time_sec NULL = course-wide note; drawing = flattened PNG drawn over the text.
CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL,
  lesson_id    TEXT,
  time_sec     REAL,
  text         TEXT NOT NULL DEFAULT '',
  drawing      BLOB,
  drawing_mime TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_course ON notes(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, section_order, sort_order);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
CREATE INDEX IF NOT EXISTS idx_subtitles_lesson ON subtitles(lesson_id);
`);
