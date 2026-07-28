import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

/** Returns the video duration in seconds via ffprobe (null when unavailable) */
export function probeDuration(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absPath],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const dur = parseFloat(stdout.trim());
        resolve(Number.isFinite(dur) ? dur : null);
      }
    );
  });
}

let filling = false;
/** Fills in missing durations in the background (does not block the server) */
export async function fillMissingDurations(): Promise<void> {
  if (filling) return;
  filling = true;
  try {
    const rows = db
      .prepare("SELECT id, rel_path FROM lessons WHERE duration IS NULL")
      .all() as unknown as { id: string; rel_path: string }[];
    if (rows.length === 0) return;
    console.log(`[ffprobe] computing duration for ${rows.length} lessons...`);
    const update = db.prepare("UPDATE lessons SET duration = ? WHERE id = ?");
    for (const row of rows) {
      const dur = await probeDuration(path.join(config.coursesPath, row.rel_path));
      if (dur !== null) update.run(dur, row.id);
    }
    console.log("[ffprobe] durations filled in");
  } finally {
    filling = false;
  }
}

/** Generates (and caches) the course thumbnail from its first video */
export function generateThumb(courseId: string, videoAbs: string): Promise<string | null> {
  const thumbPath = path.join(config.dataPath, "thumbs", `${courseId}.jpg`);
  if (fs.existsSync(thumbPath)) return Promise.resolve(thumbPath);
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      [
        "-ss", "60", // a frame at 60s usually skips the intro/black screen
        "-i", videoAbs,
        "-frames:v", "1",
        "-vf", "scale=640:-2",
        "-q:v", "4",
        "-y", thumbPath
      ],
      { timeout: 60_000 },
      (err) => {
        if (!err && fs.existsSync(thumbPath)) return resolve(thumbPath);
        // video shorter than 60s: try near the beginning
        execFile(
          "ffmpeg",
          ["-ss", "3", "-i", videoAbs, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-y", thumbPath],
          { timeout: 60_000 },
          (err2) => resolve(!err2 && fs.existsSync(thumbPath) ? thumbPath : null)
        );
      }
    );
  });
}

/** Video width/height via ffprobe (null when unavailable) */
function probeDims(absPath: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", absPath],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const [w, h] = stdout.trim().split(",").map(Number);
        resolve(w > 0 && h > 0 ? { width: w, height: h } : null);
      }
    );
  });
}

const execFileP = (cmd: string, args: string[], timeout: number) =>
  new Promise<boolean>((resolve) => execFile(cmd, args, { timeout }, (err) => resolve(!err)));

// temporary directory for intermediate ffmpeg output
const tmpDir = () => {
  const dir = path.join(config.dataPath, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ---------- per-lesson thumbnails ----------

// semaphore: caps concurrent ffmpeg processes (the browser asks for many thumbs at once)
const THUMB_SLOTS = 3;
let thumbActive = 0;
const thumbWaiting: (() => void)[] = [];
const thumbAcquire = () =>
  new Promise<void>((resolve) => {
    if (thumbActive < THUMB_SLOTS) {
      thumbActive++;
      resolve();
    } else thumbWaiting.push(resolve);
  });
const thumbRelease = () => {
  const next = thumbWaiting.shift();
  if (next) next();
  else thumbActive--;
};

/** Generates (and caches in the database) a lesson thumbnail; returns the JPEG or null */
export async function getLessonThumb(lessonId: string): Promise<Uint8Array | null> {
  const cached = db.prepare("SELECT img FROM lesson_thumbs WHERE lesson_id = ?").get(lessonId) as
    | { img: Uint8Array }
    | undefined;
  if (cached) return cached.img;

  await thumbAcquire();
  try {
    // another request may have generated it while this one waited for a slot
    const again = db.prepare("SELECT img FROM lesson_thumbs WHERE lesson_id = ?").get(lessonId) as
      | { img: Uint8Array }
      | undefined;
    if (again) return again.img;

    const lesson = db.prepare("SELECT rel_path, duration FROM lessons WHERE id = ?").get(lessonId) as
      | { rel_path: string; duration: number | null }
      | undefined;
    if (!lesson) return null;
    const videoAbs = path.join(config.coursesPath, lesson.rel_path);
    if (!fs.existsSync(videoAbs)) return null;

    // frame at ~20% of the lesson (skips intro/black screen); falls back to the start
    const at = lesson.duration ? Math.min(lesson.duration * 0.2, 120) : 30;
    const out = path.join(tmpDir(), `thumb-${lessonId}.jpg`);
    const args = (ss: number) => [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(Math.floor(ss)),
      "-i", videoAbs,
      "-frames:v", "1",
      "-vf", "scale=320:-2",
      "-q:v", "6",
      "-y", out
    ];
    let ok = await execFileP("ffmpeg", args(at), 60_000);
    if (!ok || !fs.existsSync(out)) ok = await execFileP("ffmpeg", args(1), 60_000);
    if (!ok || !fs.existsSync(out)) return null;

    const img = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    db.prepare("INSERT OR REPLACE INTO lesson_thumbs (lesson_id, img) VALUES (?, ?)").run(lessonId, img);
    return img;
  } finally {
    thumbRelease();
  }
}

/** Grabs a 640px frame from a lesson (to be used as the course banner) */
export async function generateFrameFromLesson(lessonId: string): Promise<Uint8Array | null> {
  const lesson = db.prepare("SELECT rel_path, duration FROM lessons WHERE id = ?").get(lessonId) as
    | { rel_path: string; duration: number | null }
    | undefined;
  if (!lesson) return null;
  const videoAbs = path.join(config.coursesPath, lesson.rel_path);
  if (!fs.existsSync(videoAbs)) return null;

  const at = lesson.duration ? Math.min(lesson.duration * 0.2, 120) : 30;
  const out = path.join(tmpDir(), `banner-${lessonId}.jpg`);
  const args = (ss: number) => [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.floor(ss)),
    "-i", videoAbs,
    "-frames:v", "1",
    "-vf", "scale=640:-2",
    "-q:v", "4",
    "-y", out
  ];
  let ok = await execFileP("ffmpeg", args(at), 60_000);
  if (!ok || !fs.existsSync(out)) ok = await execFileP("ffmpeg", args(1), 60_000);
  if (!ok || !fs.existsSync(out)) return null;
  const img = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return img;
}

// ---------- trickplay (timeline preview) ----------

const TP_COLS = 5;
const TP_ROWS = 5;
const TP_WIDTH = 240;

/** Builds the trickplay sprite sheets for a lesson and stores them in the database */
async function generateTrickplay(lessonId: string, relPath: string, duration: number): Promise<void> {
  const videoAbs = path.join(config.coursesPath, relPath);
  const markFailed = (): void => {
    db.prepare(
      "INSERT OR REPLACE INTO trickplay (lesson_id, interval, tile_w, tile_h, tile_cols, tile_rows, frames, sheets) VALUES (?, 10, 0, 0, 0, 0, 0, 0)"
    ).run(lessonId);
  };

  if (!fs.existsSync(videoAbs) || duration < 10) return markFailed();

  const dims = await probeDims(videoAbs);
  if (!dims) return markFailed();

  // dynamic interval: aims for ~300 frames per lesson (5s..30s)
  const interval = Math.min(30, Math.max(5, Math.ceil(duration / 300)));
  const tileH = Math.max(2, 2 * Math.round((TP_WIDTH * dims.height) / dims.width / 2));
  const frames = Math.max(1, Math.floor(duration / interval));

  const dir = fs.mkdtempSync(path.join(tmpDir(), "tp-"));
  try {
    // -skip_frame nokey: decode keyframes only (much faster; fps duplicates the nearest frame)
    const ok = await execFileP(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-skip_frame", "nokey",
        "-i", videoAbs,
        "-an", "-sn",
        "-vf", `fps=1/${interval},scale=${TP_WIDTH}:${tileH},tile=${TP_COLS}x${TP_ROWS}`,
        "-q:v", "9",
        "-y", path.join(dir, "sheet-%04d.jpg")
      ],
      15 * 60_000
    );
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    if (!ok || files.length === 0) return markFailed();

    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM trickplay_sheets WHERE lesson_id = ?").run(lessonId);
      const ins = db.prepare("INSERT INTO trickplay_sheets (lesson_id, idx, img) VALUES (?, ?, ?)");
      files.forEach((f, i) => ins.run(lessonId, i, fs.readFileSync(path.join(dir, f))));
      db.prepare(
        "INSERT OR REPLACE INTO trickplay (lesson_id, interval, tile_w, tile_h, tile_cols, tile_rows, frames, sheets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(lessonId, interval, TP_WIDTH, tileH, TP_COLS, TP_ROWS, Math.min(frames, files.length * TP_COLS * TP_ROWS), files.length);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let tpRunning = false;
/** Builds trickplay for lessons that do not have it yet, in the background */
export async function generateMissingTrickplay(): Promise<void> {
  if (tpRunning) return;
  tpRunning = true;
  try {
    // drop blobs belonging to lessons that left the catalog
    db.exec("DELETE FROM trickplay WHERE lesson_id NOT IN (SELECT id FROM lessons)");
    db.exec("DELETE FROM trickplay_sheets WHERE lesson_id NOT IN (SELECT id FROM lessons)");
    db.exec("DELETE FROM lesson_thumbs WHERE lesson_id NOT IN (SELECT id FROM lessons)");

    const rows = db
      .prepare(
        `SELECT id, rel_path, duration FROM lessons
         WHERE duration IS NOT NULL AND id NOT IN (SELECT lesson_id FROM trickplay)
         ORDER BY course_id, section_order, sort_order`
      )
      .all() as unknown as { id: string; rel_path: string; duration: number }[];
    if (rows.length === 0) return;
    console.log(`[trickplay] building timeline previews for ${rows.length} lessons...`);
    let done = 0;
    for (const row of rows) {
      try {
        await generateTrickplay(row.id, row.rel_path, row.duration);
      } catch (err) {
        console.error(`[trickplay] failed on ${row.rel_path}:`, err);
      }
      done++;
      if (done % 25 === 0) console.log(`[trickplay] ${done}/${rows.length}`);
    }
    console.log(`[trickplay] finished (${done} lessons)`);
  } finally {
    tpRunning = false;
  }
}

// ---------- streaming (remux / transcode) ----------

export interface MediaCodecs {
  video: string | null;
  audio: string | null;
}

// video codecs the browser can play inside mp4 without re-encoding
const COPY_VIDEO = new Set(["h264", "hevc", "vp9", "av1"]);

const codecsCache = new Map<string, MediaCodecs>();

/** Video/audio codecs of a file via ffprobe (cached in memory) */
export function probeCodecs(absPath: string): Promise<MediaCodecs> {
  const cached = codecsCache.get(absPath);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", absPath],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve({ video: null, audio: null });
        try {
          const streams = (JSON.parse(stdout).streams ?? []) as { codec_type?: string; codec_name?: string }[];
          const info: MediaCodecs = {
            video: streams.find((s) => s.codec_type === "video")?.codec_name ?? null,
            audio: streams.find((s) => s.codec_type === "audio")?.codec_name ?? null
          };
          codecsCache.set(absPath, info);
          resolve(info);
        } catch {
          resolve({ video: null, audio: null });
        }
      }
    );
  });
}

/**
 * Streams fragmented mp4 to the browser.
 * Copies the video stream when the codec is compatible (h264/hevc/vp9/av1),
 * otherwise re-encodes to h264. AAC audio is copied, anything else becomes AAC.
 * Embedded subtitles, attachments and extra tracks are dropped — they break the
 * mp4 muxer (this was what used to stall mkv/mov playback).
 */
export function remuxStream(absPath: string, startSec: number, transcode: boolean, codecs: MediaCodecs) {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (startSec > 0) args.push("-ss", String(startSec));
  args.push("-i", absPath);
  // first video/audio track only; no subtitles/attachments/data
  args.push("-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1");

  const copyVideo = !transcode && codecs.video !== null && COPY_VIDEO.has(codecs.video);
  if (copyVideo) {
    args.push("-c:v", "copy");
    if (codecs.video === "hevc") args.push("-tag:v", "hvc1"); // without the tag browsers do not recognize hevc
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p", // 10-bit/4:2:2 sources (common in .mov/ProRes) will not play without this
      "-g", "60"
    );
  }
  if (!transcode && codecs.audio === "aac") args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");

  args.push(
    "-max_muxing_queue_size", "1024",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1"
  );
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  // log why ffmpeg died on its own (a kill from client disconnect exits with code null)
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  ff.on("close", (code) => {
    if (code && code !== 0)
      console.error(`[stream] ffmpeg failed (${path.basename(absPath)}):`, stderr.trim().slice(0, 500));
  });
  return ff;
}
