import { Router, raw } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { scanLibrary } from "./scanner.js";
import {
  fillMissingDurations,
  generateFrameFromLesson,
  generateMissingTrickplay,
  generateThumb,
  getLessonThumb,
  probeCodecs,
  remuxStream
} from "./ffmpeg.js";

export const api = Router();

const absPath = (relPath: string) => path.join(config.coursesPath, relPath);

// mp4/webm play natively in the browser; everything else (mkv, avi, mov) goes through remux
const DIRECT_PLAY = new Set([".mp4", ".m4v", ".webm"]);

// ---------- material types ----------
export type MaterialKind = "video" | "image" | "pdf" | "text" | "audio" | "html" | "brush" | "psd" | "clip" | "archive" | "other";

const KIND_BY_EXT: Record<string, MaterialKind> = {
  ".mov": "video", ".mp4": "video", ".m4v": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".bmp": "image",
  ".pdf": "pdf",
  ".html": "html", ".htm": "html",
  ".txt": "text", ".md": "text",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
  ".abr": "brush",
  ".psd": "psd", ".psb": "psd",
  ".clip": "clip",
  ".zip": "archive", ".rar": "archive", ".7z": "archive"
};

// kinds the browser can open directly (or through remux, for video)
const VIEWABLE: Set<MaterialKind> = new Set(["video", "image", "pdf", "text", "audio", "html"]);

const materialKind = (relPath: string): MaterialKind =>
  KIND_BY_EXT[path.extname(relPath).toLowerCase()] ?? "other";

interface CourseSummary {
  id: string;
  title: string;
  category: string | null;
  teacher: string | null;
  status: string;
  banner: string | null;
  lesson_count: number;
  completed_count: number;
  section_count: number;
  total_duration: number | null;
  missing_durations: number;
  last_watched: string | null;
}

// ---------- Home ----------
api.get("/courses", (_req, res) => {
  const courses = db
    .prepare(
      `SELECT c.id,
              COALESCE(m.title, c.title) AS title,
              COALESCE(m.category, c.category) AS category,
              m.teacher AS teacher,
              c.status, c.banner,
              COUNT(l.id) AS lesson_count,
              COALESCE(SUM(CASE WHEN p.completed = 1 THEN 1 ELSE 0 END), 0) AS completed_count,
              COUNT(DISTINCT l.section) AS section_count,
              SUM(l.duration) AS total_duration,
              COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND l.duration IS NULL THEN 1 ELSE 0 END), 0) AS missing_durations,
              MAX(p.updated_at) AS last_watched
       FROM courses c
       LEFT JOIN course_meta m ON m.course_id = c.id
       LEFT JOIN lessons l ON l.course_id = c.id
       LEFT JOIN progress p ON p.lesson_id = l.id
       GROUP BY c.id
       ORDER BY LOWER(COALESCE(m.title, c.sort_title))`
    )
    .all() as unknown as CourseSummary[];

  // recent activity (in progress OR completed) — one card per course:
  // a half-watched lesson resumes where it stopped, a completed one suggests the next lesson
  const recent = db
    .prepare(
      `SELECT p.lesson_id AS lessonId, p.position_sec AS position, p.updated_at AS updatedAt,
              p.completed, l.title AS lessonTitle, l.duration, l.course_id AS courseId,
              l.section_order AS sectionOrder, l.sort_order AS sortOrder, c.title AS courseTitle
       FROM progress p
       JOIN lessons l ON l.id = p.lesson_id
       JOIN courses c ON c.id = l.course_id
       WHERE p.completed = 1 OR p.position_sec > 10
       ORDER BY p.updated_at DESC
       LIMIT 40`
    )
    .all() as unknown as {
    lessonId: string;
    position: number;
    updatedAt: string;
    completed: number;
    lessonTitle: string;
    duration: number | null;
    courseId: string;
    sectionOrder: number;
    sortOrder: number;
    courseTitle: string;
  }[];

  const nextLessonStmt = db.prepare(
    `SELECT l.id AS lessonId, l.title AS lessonTitle, l.duration,
            COALESCE(p.position_sec, 0) AS position
     FROM lessons l
     LEFT JOIN progress p ON p.lesson_id = l.id
     WHERE l.course_id = ? AND COALESCE(p.completed, 0) = 0
     ORDER BY (l.section_order > ? OR (l.section_order = ? AND l.sort_order > ?)) DESC,
              l.section_order, l.sort_order
     LIMIT 1`
  );

  const continueWatching: Record<string, unknown>[] = [];
  const seenCourses = new Set<string>();
  for (const r of recent) {
    if (continueWatching.length >= 10) break;
    if (seenCourses.has(r.courseId)) continue;
    seenCourses.add(r.courseId);
    if (!r.completed) {
      continueWatching.push({
        lessonId: r.lessonId,
        position: r.position,
        updatedAt: r.updatedAt,
        lessonTitle: r.lessonTitle,
        duration: r.duration,
        courseId: r.courseId,
        courseTitle: r.courseTitle,
        isNext: false
      });
    } else {
      // next unfinished lesson (preferring the one right after; fully watched courses are skipped)
      const next = nextLessonStmt.get(r.courseId, r.sectionOrder, r.sectionOrder, r.sortOrder) as
        | { lessonId: string; lessonTitle: string; duration: number | null; position: number }
        | undefined;
      if (!next) continue;
      continueWatching.push({
        lessonId: next.lessonId,
        position: next.position,
        updatedAt: r.updatedAt,
        lessonTitle: next.lessonTitle,
        duration: next.duration,
        courseId: r.courseId,
        courseTitle: r.courseTitle,
        isNext: true
      });
    }
  }

  res.json({
    courses: courses.map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      teacher: c.teacher,
      status: c.status,
      hasBanner: c.status === "ready" || c.banner !== null,
      lessonCount: c.lesson_count,
      completedCount: c.completed_count,
      sectionCount: c.section_count,
      totalDuration: c.total_duration,
      // durations still being computed by ffprobe: the total shown is partial
      durationPartial: c.missing_durations > 0,
      progressPct: c.lesson_count > 0 ? Math.round((c.completed_count / c.lesson_count) * 100) : 0,
      lastWatched: c.last_watched
    })),
    continueWatching
  });
});

// ---------- Course page ----------
api.get("/courses/:id", (req, res) => {
  const course = db
    .prepare(
      `SELECT c.*, m.title AS meta_title, m.category AS meta_category, m.teacher AS teacher,
              (m.banner IS NOT NULL) AS has_custom_banner
       FROM courses c LEFT JOIN course_meta m ON m.course_id = c.id
       WHERE c.id = ?`
    )
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!course) return res.status(404).json({ error: "Course not found" });

  const lessons = db
    .prepare(
      `SELECT l.id, l.section, l.section_order, l.sort_order, l.title, l.duration,
              COALESCE(p.position_sec, 0) AS position, COALESCE(p.completed, 0) AS completed
       FROM lessons l
       LEFT JOIN progress p ON p.lesson_id = l.id
       WHERE l.course_id = ?
       ORDER BY l.section_order, l.sort_order`
    )
    .all(req.params.id) as unknown as {
    id: string;
    section: string | null;
    section_order: number;
    title: string;
    duration: number | null;
    position: number;
    completed: number;
  }[];

  // group by section, preserving order
  const sections: { title: string | null; lessons: typeof lessons }[] = [];
  for (const l of lessons) {
    const last = sections[sections.length - 1];
    if (!last || last.title !== l.section) sections.push({ title: l.section, lessons: [l] });
    else last.lessons.push(l);
  }

  const materials = (
    db
      .prepare("SELECT id, name, size, rel_path FROM materials WHERE course_id = ? ORDER BY name")
      .all(req.params.id) as unknown as { id: string; name: string; size: number; rel_path: string }[]
  ).map((m) => {
    const kind = materialKind(m.rel_path);
    return { id: m.id, name: m.name, size: m.size, kind, viewable: VIEWABLE.has(kind) };
  });

  res.json({
    ...course,
    title: course.meta_title ?? course.title,
    category: course.meta_category ?? course.category,
    teacher: course.teacher ?? null,
    // values derived from the folder (so the edit form knows the defaults)
    folderTitle: course.title,
    folderCategory: course.category,
    hasCustomBanner: Boolean(course.has_custom_banner),
    sections,
    materials
  });
});

// ---------- Course metadata editing ----------
const courseExists = (id: string) => db.prepare("SELECT 1 FROM courses WHERE id = ?").get(id) !== undefined;

api.put("/courses/:id/meta", (req, res) => {
  if (!courseExists(req.params.id)) return res.status(404).json({ error: "Course not found" });
  const norm = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const { title, category, teacher } = req.body as Record<string, unknown>;
  db.prepare(
    `INSERT INTO course_meta (course_id, title, category, teacher) VALUES (?, ?, ?, ?)
     ON CONFLICT(course_id) DO UPDATE SET title = excluded.title,
       category = excluded.category, teacher = excluded.teacher`
  ).run(req.params.id, norm(title), norm(category), norm(teacher));
  res.json({ ok: true });
});

// lessons spread across the course, so the user can pick a frame as the banner
api.get("/courses/:id/thumb-suggestions", (req, res) => {
  const lessons = db
    .prepare("SELECT id, title FROM lessons WHERE course_id = ? ORDER BY section_order, sort_order")
    .all(req.params.id) as unknown as { id: string; title: string }[];
  const n = Math.min(8, lessons.length);
  const picks: { id: string; title: string }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.floor((i * (lessons.length - 1)) / (n - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      picks.push(lessons[idx]);
    }
  }
  res.json(picks);
});

const saveBanner = (courseId: string, img: Uint8Array | null, mime: string | null) =>
  db.prepare(
    `INSERT INTO course_meta (course_id, banner, banner_mime) VALUES (?, ?, ?)
     ON CONFLICT(course_id) DO UPDATE SET banner = excluded.banner, banner_mime = excluded.banner_mime`
  ).run(courseId, img, mime);

// image upload (raw body: image/jpeg, image/png, image/webp)
api.post("/courses/:id/banner", raw({ type: "image/*", limit: "15mb" }), (req, res) => {
  if (!courseExists(req.params.id)) return res.status(404).json({ error: "Course not found" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: "Send the image in the request body (Content-Type image/*)" });
  saveBanner(req.params.id, req.body, req.headers["content-type"] ?? "image/jpeg");
  res.json({ ok: true });
});

// use a frame from a lesson as the course banner
api.post("/courses/:id/banner/from-lesson", async (req, res) => {
  const { lessonId } = req.body as { lessonId?: string };
  if (!lessonId) return res.status(400).json({ error: "lessonId is required" });
  const lesson = db.prepare("SELECT course_id FROM lessons WHERE id = ?").get(lessonId) as
    | { course_id: string }
    | undefined;
  if (!lesson || lesson.course_id !== req.params.id)
    return res.status(404).json({ error: "Lesson not found in this course" });
  const img = await generateFrameFromLesson(lessonId);
  if (!img) return res.status(500).json({ error: "Could not extract the frame" });
  saveBanner(req.params.id, img, "image/jpeg");
  res.json({ ok: true });
});

// drop the custom image (falls back to cover.jpg / auto-generated frame)
api.delete("/courses/:id/banner", (req, res) => {
  db.prepare("UPDATE course_meta SET banner = NULL, banner_mime = NULL WHERE course_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Player payload ----------
api.get("/lessons/:id", (req, res) => {
  const lesson = db
    .prepare(
      `SELECT l.*, COALESCE(p.position_sec, 0) AS position, COALESCE(p.completed, 0) AS completed
       FROM lessons l LEFT JOIN progress p ON p.lesson_id = l.id
       WHERE l.id = ?`
    )
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!lesson) return res.status(404).json({ error: "Lesson not found" });

  const course = db.prepare("SELECT id, title FROM courses WHERE id = ?").get(lesson.course_id as string);
  const siblings = db
    .prepare("SELECT id, title FROM lessons WHERE course_id = ? ORDER BY section_order, sort_order")
    .all(lesson.course_id as string) as unknown as { id: string; title: string }[];
  const idx = siblings.findIndex((s) => s.id === req.params.id);

  const subtitles = db
    .prepare("SELECT id, lang FROM subtitles WHERE lesson_id = ? ORDER BY lang")
    .all(req.params.id);

  const ext = path.extname(lesson.rel_path as string).toLowerCase();

  res.json({
    id: lesson.id,
    title: lesson.title,
    section: lesson.section,
    duration: lesson.duration,
    position: lesson.position,
    completed: lesson.completed,
    course,
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
    subtitles,
    directPlay: DIRECT_PLAY.has(ext)
  });
});

// ---------- Streaming ----------
api.get("/stream/:id", async (req, res) => {
  const lesson = db.prepare("SELECT rel_path FROM lessons WHERE id = ?").get(req.params.id) as
    | { rel_path: string }
    | undefined;
  if (!lesson) return res.status(404).end();
  const file = absPath(lesson.rel_path);
  if (!fs.existsSync(file)) return res.status(404).end();

  const ext = path.extname(file).toLowerCase();
  const transcode = req.query.transcode === "1";

  if (DIRECT_PLAY.has(ext) && !transcode) {
    // Direct streaming with Range support (native seeking)
    const stat = fs.statSync(file);
    const contentType = ext === ".webm" ? "video/webm" : "video/mp4";
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start >= stat.size) return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", end - start + 1);
      res.setHeader("Content-Type", contentType);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", "bytes");
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  // Remux (mkv and friends): fragmented mp4 via ffmpeg; seeking = new request with ?t=
  const startSec = Math.max(0, Number(req.query.t) || 0);
  const codecs = await probeCodecs(file);
  res.setHeader("Content-Type", "video/mp4");
  const ff = remuxStream(file, startSec, transcode, codecs);
  ff.stdout.pipe(res);
  const kill = () => {
    try {
      ff.kill("SIGKILL");
    } catch {}
  };
  res.on("close", kill);
  ff.on("error", () => res.destroy());
});

// ---------- Subtitles (SRT -> WebVTT) ----------
function srtToVtt(buf: Buffer): string {
  let text = buf.toString("utf8");
  if (text.includes("�")) text = buf.toString("latin1"); // legacy latin1 files
  text = text.replace(/^﻿/, "");
  if (/^\s*WEBVTT/.test(text)) return text;
  const converted = text
    .replace(/\r+/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + converted;
}

api.get("/subtitles/:id", (req, res) => {
  const sub = db.prepare("SELECT rel_path FROM subtitles WHERE id = ?").get(req.params.id) as
    | { rel_path: string }
    | undefined;
  if (!sub) return res.status(404).end();
  const file = absPath(sub.rel_path);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.send(srtToVtt(fs.readFileSync(file)));
});

// ---------- Materials ----------
api.get("/materials/:id", (req, res) => {
  const mat = db.prepare("SELECT rel_path, name FROM materials WHERE id = ?").get(req.params.id) as
    | { rel_path: string; name: string }
    | undefined;
  if (!mat) return res.status(404).end();
  const file = absPath(mat.rel_path);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.download(file, path.basename(mat.rel_path));
});

// view a material in the browser (image/pdf/txt directly; video through remux when needed)
api.get("/materials/:id/view", async (req, res) => {
  const mat = db.prepare("SELECT rel_path FROM materials WHERE id = ?").get(req.params.id) as
    | { rel_path: string }
    | undefined;
  if (!mat) return res.status(404).end();
  const file = absPath(mat.rel_path);
  if (!fs.existsSync(file)) return res.status(404).end();

  const ext = path.extname(file).toLowerCase();
  const kind = materialKind(mat.rel_path);

  if (kind === "video" && !DIRECT_PLAY.has(ext)) {
    // .mov/.mkv/.avi: remux to fragmented mp4, same as lessons
    const codecs = await probeCodecs(file);
    res.setHeader("Content-Type", "video/mp4");
    const ff = remuxStream(file, 0, false, codecs);
    ff.stdout.pipe(res);
    const kill = () => {
      try {
        ff.kill("SIGKILL");
      } catch {}
    };
    res.on("close", kill);
    ff.on("error", () => res.destroy());
    return;
  }

  if (!VIEWABLE.has(kind)) {
    // cannot be opened in the browser — fall back to download
    return res.download(file, path.basename(mat.rel_path));
  }

  if (kind === "text") res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (kind === "html") res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(file); // sendFile already handles Content-Type and Range (mp4 seeking)
});

// ---------- Thumbnails / banners ----------
const sendJpeg = (res: import("express").Response, img: Uint8Array) => {
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.end(Buffer.from(img.buffer, img.byteOffset, img.byteLength));
};

// lesson thumbnail (generated on demand and cached in the database)
api.get("/thumb/lesson/:id", async (req, res) => {
  const img = await getLessonThumb(req.params.id);
  if (!img) return res.status(404).end();
  sendJpeg(res, img);
});

api.get("/thumb/:courseId", async (req, res) => {
  const course = db.prepare("SELECT id, banner FROM courses WHERE id = ?").get(req.params.courseId) as
    | { id: string; banner: string | null }
    | undefined;
  if (!course) return res.status(404).end();

  // an image picked/uploaded by the user always wins
  const meta = db
    .prepare("SELECT banner, banner_mime FROM course_meta WHERE course_id = ?")
    .get(course.id) as { banner: Uint8Array | null; banner_mime: string | null } | undefined;
  if (meta?.banner) {
    res.setHeader("Content-Type", meta.banner_mime ?? "image/jpeg");
    res.setHeader("Cache-Control", "no-cache");
    return res.end(Buffer.from(meta.banner.buffer, meta.banner.byteOffset, meta.banner.byteLength));
  }

  // then, a manual cover.jpg in the folder
  if (course.banner) {
    const file = absPath(course.banner);
    if (fs.existsSync(file)) return res.sendFile(file);
  }

  // otherwise, grab a frame from the first video
  const first = db
    .prepare("SELECT rel_path FROM lessons WHERE course_id = ? ORDER BY section_order, sort_order LIMIT 1")
    .get(course.id) as { rel_path: string } | undefined;
  if (!first) return res.status(404).end();
  const thumb = await generateThumb(course.id, absPath(first.rel_path));
  if (!thumb) return res.status(404).end();
  res.sendFile(thumb);
});

// ---------- Trickplay (timeline preview) ----------
api.get("/trickplay/:id", (req, res) => {
  const tp = db
    .prepare(
      "SELECT interval, tile_w, tile_h, tile_cols, tile_rows, frames, sheets FROM trickplay WHERE lesson_id = ?"
    )
    .get(req.params.id) as
    | { interval: number; tile_w: number; tile_h: number; tile_cols: number; tile_rows: number; frames: number; sheets: number }
    | undefined;
  if (!tp || tp.frames === 0) return res.status(404).json({ error: "Trickplay unavailable" });
  res.json({
    interval: tp.interval,
    tileW: tp.tile_w,
    tileH: tp.tile_h,
    cols: tp.tile_cols,
    rows: tp.tile_rows,
    frames: tp.frames,
    sheets: tp.sheets
  });
});

api.get("/trickplay/:id/:sheet", (req, res) => {
  const row = db
    .prepare("SELECT img FROM trickplay_sheets WHERE lesson_id = ? AND idx = ?")
    .get(req.params.id, Number(req.params.sheet) || 0) as { img: Uint8Array } | undefined;
  if (!row) return res.status(404).end();
  sendJpeg(res, row.img);
});

// ---------- Progress ----------
api.post("/progress", (req, res) => {
  const { lessonId, position, completed } = req.body as {
    lessonId?: string;
    position?: number;
    completed?: boolean;
  };
  if (!lessonId) return res.status(400).json({ error: "lessonId is required" });
  const lesson = db.prepare("SELECT id, duration FROM lessons WHERE id = ?").get(lessonId) as
    | { id: string; duration: number | null }
    | undefined;
  if (!lesson) return res.status(404).json({ error: "Lesson not found" });

  const pos = Math.max(0, Number(position) || 0);
  let done: number;
  if (typeof completed === "boolean") {
    done = completed ? 1 : 0; // manual toggle
  } else {
    const existing = db.prepare("SELECT completed FROM progress WHERE lesson_id = ?").get(lessonId) as
      | { completed: number }
      | undefined;
    done = existing?.completed ?? 0;
    // auto-complete: >= 90% watched, or 30s or less left
    // (the 30s rule only applies to lessons longer than 60s, otherwise short
    // videos would complete on the very first save)
    if (
      !done &&
      lesson.duration &&
      (pos / lesson.duration >= 0.9 || (lesson.duration > 60 && lesson.duration - pos <= 30))
    )
      done = 1;
  }

  db.prepare(
    `INSERT INTO progress (lesson_id, position_sec, completed, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(lesson_id) DO UPDATE SET position_sec = excluded.position_sec,
       completed = excluded.completed, updated_at = excluded.updated_at`
  ).run(lessonId, pos, done);

  res.json({ ok: true, completed: done === 1 });
});

// ---------- Notes ----------
// Course notes: listed without the drawing blob (only the hasDrawing flag)
api.get("/courses/:id/notes", (req, res) => {
  if (!courseExists(req.params.id)) return res.status(404).json({ error: "Course not found" });
  const rows = db
    .prepare(
      `SELECT n.id, n.lesson_id AS lessonId, n.time_sec AS timeSec, n.text,
              n.created_at AS createdAt, n.updated_at AS updatedAt,
              (n.drawing IS NOT NULL) AS hasDrawing, l.title AS lessonTitle
       FROM notes n LEFT JOIN lessons l ON l.id = n.lesson_id
       WHERE n.course_id = ?
       ORDER BY (n.lesson_id IS NOT NULL), l.section_order, l.sort_order, n.time_sec, n.created_at`
    )
    .all(req.params.id) as unknown as Record<string, unknown>[];
  res.json(rows.map((r) => ({ ...r, hasDrawing: Boolean(r.hasDrawing) })));
});

api.post("/courses/:id/notes", (req, res) => {
  if (!courseExists(req.params.id)) return res.status(404).json({ error: "Course not found" });
  const { lessonId, timeSec, text } = req.body as { lessonId?: string; timeSec?: number; text?: string };
  if (lessonId) {
    const lesson = db.prepare("SELECT course_id FROM lessons WHERE id = ?").get(lessonId) as
      | { course_id: string }
      | undefined;
    if (!lesson || lesson.course_id !== req.params.id)
      return res.status(404).json({ error: "Lesson not found in this course" });
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO notes (id, course_id, lesson_id, time_sec, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    id,
    req.params.id,
    lessonId ?? null,
    lessonId && timeSec != null ? Math.max(0, Number(timeSec) || 0) : null,
    typeof text === "string" ? text : ""
  );
  res.json({ ok: true, id });
});

api.put("/notes/:id", (req, res) => {
  const { text } = req.body as { text?: string };
  const r = db
    .prepare("UPDATE notes SET text = ?, updated_at = datetime('now') WHERE id = ?")
    .run(typeof text === "string" ? text : "", req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: "Note not found" });
  res.json({ ok: true });
});

api.delete("/notes/:id", (req, res) => {
  db.prepare("DELETE FROM notes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// drawing layered over the text (flattened PNG, raw body like the banner)
api.put("/notes/:id/drawing", raw({ type: "image/*", limit: "15mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: "Send the image in the request body (Content-Type image/*)" });
  const r = db
    .prepare("UPDATE notes SET drawing = ?, drawing_mime = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body, req.headers["content-type"] ?? "image/png", req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: "Note not found" });
  res.json({ ok: true });
});

api.get("/notes/:id/drawing", (req, res) => {
  const row = db.prepare("SELECT drawing, drawing_mime FROM notes WHERE id = ?").get(req.params.id) as
    | { drawing: Uint8Array | null; drawing_mime: string | null }
    | undefined;
  if (!row || !row.drawing) return res.status(404).end();
  res.setHeader("Content-Type", row.drawing_mime ?? "image/png");
  res.send(Buffer.from(row.drawing));
});

api.delete("/notes/:id/drawing", (req, res) => {
  const r = db
    .prepare("UPDATE notes SET drawing = NULL, drawing_mime = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: "Note not found" });
  res.json({ ok: true });
});

// ---------- Rescan ----------
api.post("/scan", (_req, res) => {
  const result = scanLibrary();
  void fillMissingDurations().then(() => generateMissingTrickplay());
  res.json(result);
});
