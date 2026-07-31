import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  apiGet,
  CourseDetail,
  fmtClock,
  fmtDuration,
  listNotes,
  NoteRow,
  PlayerData,
  saveProgress,
  TrickplayMeta
} from "../api";
import Materials from "../components/Materials";
import NotesPanel from "../components/NotesPanel";
import {
  IconCC,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconForward10,
  IconFullscreen,
  IconNote,
  IconPause,
  IconPlay,
  IconPlayOutline,
  IconRewind10,
  IconSettings,
  IconSkipNext,
  IconSkipPrev,
  IconTypography,
  IconVolume,
  IconVolumeMute,
  IconX
} from "../components/Icons";

const SUB_PREF_KEY = "artschool.sublang";
const AUTONEXT_KEY = "artschool.autonext";
const RATE_KEY = "artschool.rate";
const SUBSTYLE_KEY = "artschool.substyle";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// volume goes up to 200%: above 100% the video element stays at 1 and the rest
// comes from a GainNode (Web Audio)
const MAX_VOLUME = 2;

// how the video reaches the browser; on a playback error it escalates direct -> remux -> transcode
type StreamMode = "direct" | "remux" | "transcode";
type MenuId = "cc" | "settings" | "substyle" | null;

// global subtitle style (shared across every course)
interface SubStyle {
  size: number; // px
  color: string;
  bg: number; // background opacity 0..1
  outline: boolean;
}

const DEFAULT_SUBSTYLE: SubStyle = { size: 22, color: "#ffffff", bg: 0.75, outline: false };

const SUB_COLORS = ["#ffffff", "#fde047", "#4ade80", "#67e8f9", "#f9a8d4", "#fb923c"];

function loadSubStyle(): SubStyle {
  try {
    return { ...DEFAULT_SUBSTYLE, ...JSON.parse(localStorage.getItem(SUBSTYLE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SUBSTYLE;
  }
}

// keeps only <i>/<b>/<u> from the subtitle text
const sanitizeCue = (t: string) => t.replace(/<(?!\/?(i|b|u)\b)[^>]*>/gi, "");

export default function Player() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const seekWrapRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<PlayerData | null>(null);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<StreamMode>("direct");
  // remux offset: the <video> starts at 0, but the real time is offset + currentTime
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0); // forces the <video> to remount when the src does not change
  const [fatal, setFatal] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() =>
    Math.max(0, Math.min(MAX_VOLUME, Number(localStorage.getItem("artschool.volume") ?? 1) || 0))
  );
  const [rate, setRate] = useState(() => Number(localStorage.getItem(RATE_KEY) ?? 1));
  const [autoNext, setAutoNext] = useState(() => localStorage.getItem(AUTONEXT_KEY) !== "0");
  const [compat, setCompat] = useState(false); // compatibility mode: forces re-encoding
  const [subLang, setSubLang] = useState<string | null>(null);
  const [subStyle, setSubStyle] = useState<SubStyle>(loadSubStyle);
  const [cueLines, setCueLines] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuId>(null);
  const [showControls, setShowControls] = useState(true);
  const [drag, setDrag] = useState<number | null>(null); // dragging the timeline
  // trickplay: frame preview while hovering the timeline
  const [tp, setTp] = useState<TrickplayMeta | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  // notes
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"lessons" | "notes">("lessons");
  const [notesDrawer, setNotesDrawer] = useState(false);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null); // note opened from a timeline marker
  const [markerHover, setMarkerHover] = useState<string | null>(null);

  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingResume = useRef(0); // pending seek for direct play (applied on loadedmetadata)
  // last known real position: on unmount the <video> is already gone, so the final
  // save cannot read videoRef (that was what used to reset progress on SPA navigation)
  const lastPos = useRef(0);
  const lastVolume = useRef(1);
  const compatRef = useRef(false);
  const menuRef = useRef<MenuId>(null);
  menuRef.current = menu;
  const notesDrawerRef = useRef(false);
  notesDrawerRef.current = notesDrawer;
  // volume booster: Web Audio graph created on demand when volume goes above 100%
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const boostElRef = useRef<HTMLVideoElement | null>(null); // element already wired to the graph
  const boostFailedRef = useRef(false);

  const updateSubStyle = (patch: Partial<SubStyle>) =>
    setSubStyle((s) => {
      const next = { ...s, ...patch };
      localStorage.setItem(SUBSTYLE_KEY, JSON.stringify(next));
      return next;
    });

  // ---- lesson loading ----
  useEffect(() => {
    setData(null);
    setOffset(0);
    setCurTime(0);
    setVideoDur(0);
    setBuffered(0);
    setFatal(null);
    setWaiting(false);
    setDrag(null);
    setMenu(null);
    setReloadKey(0);
    pendingResume.current = 0;
    apiGet<PlayerData>(`/api/lessons/${id}`)
      .then((d) => {
        setData(d);
        // a ?t= deep link (e.g. "jump to this moment" from a note) beats resuming
        const tParam = Number(searchParams.get("t"));
        // resume where it stopped (unless it is basically at the end)
        const resume =
          isFinite(tParam) && tParam > 0
            ? tParam
            : d.position > 10 && (!d.duration || d.position < d.duration - 15)
              ? d.position
              : 0;
        lastPos.current = resume;
        const m: StreamMode = compatRef.current ? "transcode" : d.directPlay ? "direct" : "remux";
        setMode(m);
        if (m === "direct") pendingResume.current = resume;
        else setOffset(Math.floor(resume));
        // preferred subtitle
        const pref = localStorage.getItem(SUB_PREF_KEY);
        const langs = d.subtitles.map((s) => s.lang);
        const pick =
          (pref && langs.includes(pref) && pref) ||
          langs.find((l) => l === "Default") ||
          langs.find((l) => /english/i.test(l)) ||
          null;
        setSubLang(pick);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  // ---- trickplay ----
  useEffect(() => {
    setTp(null);
    setHover(null);
    if (!id) return;
    apiGet<TrickplayMeta>(`/api/trickplay/${id}`).then(setTp).catch(() => {});
  }, [id]);

  // ---- course (lesson sidebar + materials) ----
  useEffect(() => {
    if (!data?.course.id) return;
    apiGet<CourseDetail>(`/api/courses/${data.course.id}`).then(setCourse).catch(() => {});
  }, [data?.course.id, id]);

  // ---- course notes ----
  const refreshNotes = useCallback(() => {
    if (!data?.course.id) return;
    listNotes(data.course.id).then(setNotes).catch(() => {});
  }, [data?.course.id]);

  useEffect(() => {
    setNotes([]);
    refreshNotes();
  }, [refreshNotes]);

  const effTime = mode === "direct" ? curTime : offset + curTime;
  // while remuxing the <video> only knows the current chunk; the total comes from
  // ffprobe (or offset + chunk length)
  const duration =
    data?.duration ??
    (videoDur > 0 && isFinite(videoDur) ? (mode === "direct" ? videoDur : offset + videoDur) : 0);

  // ---- video src ----
  const src = useMemo(() => {
    if (!data) return undefined;
    if (mode === "direct") return `/api/stream/${data.id}`;
    const base = `/api/stream/${data.id}?t=${Math.floor(offset)}`;
    return mode === "transcode" ? `${base}&transcode=1` : base;
  }, [data, mode, offset]);

  // ---- progress ----
  const save = useCallback(
    (completed?: boolean) => {
      if (!data) return;
      void saveProgress(data.id, lastPos.current, completed);
    },
    [data]
  );

  useEffect(() => {
    const iv = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) save();
    }, 5000);
    return () => clearInterval(iv);
  }, [save]);

  useEffect(() => {
    const onUnload = () => save();
    const onVis = () => {
      if (document.visibilityState === "hidden") save(); // mobile does not fire beforeunload
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onVis);
      save(); // save when leaving the page/switching lessons (uses lastPos, the <video> is gone)
    };
  }, [save]);

  // ---- stream mode switch (fallback, compat mode, remux seek) ----
  const switchMode = (m: StreamMode, at: number) => {
    setFatal(null);
    setBuffered(0);
    setWaiting(true);
    lastPos.current = at;
    if (m === "direct") {
      pendingResume.current = at;
      setOffset(0);
    } else {
      setOffset(Math.floor(at));
    }
    setCurTime(0);
    setMode(m);
    setReloadKey((k) => k + 1);
  };

  // playback error: try the next mode (direct -> remux -> transcode)
  const onVideoError = () => {
    const code = videoRef.current?.error?.code ?? 0;
    if (code === 1 || !data) return; // 1 = abort (src swap, not a real error)
    setWaiting(false);
    setPlaying(false);
    if (mode === "direct") switchMode("remux", lastPos.current);
    else if (mode === "remux") switchMode("transcode", lastPos.current);
    else setFatal(t("player.fatal_error"));
  };

  // ---- subtitles: rendered by us (customizable overlay) ----
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setCueLines([]);
    let active: TextTrack | null = null;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      t.mode = "hidden"; // never use the native renderer
      if (subLang !== null && t.label === subLang) active = t;
    }
    if (!active) return;
    const track = active;
    const onCue = () => {
      const lines: string[] = [];
      const cues = track.activeCues;
      if (cues) {
        for (let i = 0; i < cues.length; i++) {
          const cue = cues[i] as VTTCue;
          lines.push(...cue.text.split("\n").filter((l) => l.trim() !== ""));
        }
      }
      setCueLines(lines);
    };
    track.addEventListener("cuechange", onCue);
    onCue();
    return () => track.removeEventListener("cuechange", onCue);
  }, [subLang, src, data, reloadKey]);

  // closes the menus along with the controls
  useEffect(() => {
    if (!showControls) setMenu(null);
  }, [showControls]);

  // ---- volume / playback rate ----
  // wires the <video> into the gain -> compressor -> output graph (once per element;
  // the <video> remounts on every remux seek, so it is rewired when the element changes)
  const ensureBoost = (el: HTMLVideoElement) => {
    try {
      if (!audioCtxRef.current) {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        // compresses peaks so high gain does not clip/distort
        const comp = ctx.createDynamicsCompressor();
        gain.connect(comp);
        comp.connect(ctx.destination);
        audioCtxRef.current = ctx;
        gainRef.current = gain;
      }
      if (boostElRef.current !== el) {
        audioCtxRef.current.createMediaElementSource(el).connect(gainRef.current!);
        boostElRef.current = el;
      }
      void audioCtxRef.current.resume();
    } catch {
      boostFailedRef.current = true; // Web Audio unavailable: volume stays capped at 100%
    }
  };

  const applyVolume = (el: HTMLVideoElement, vol: number) => {
    if (vol > 1 && !boostFailedRef.current) ensureBoost(el);
    el.volume = Math.min(1, vol);
    if (gainRef.current && boostElRef.current === el) gainRef.current.gain.value = Math.max(1, vol);
  };

  useEffect(() => {
    if (videoRef.current) applyVolume(videoRef.current, volume);
    localStorage.setItem("artschool.volume", String(volume));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, src]);

  // closes the AudioContext when leaving the player
  useEffect(
    () => () => {
      void audioCtxRef.current?.close();
    },
    []
  );
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
    localStorage.setItem(RATE_KEY, String(rate));
  }, [rate, src]);

  const toggleMute = () => {
    if (volume > 0) {
      lastVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(lastVolume.current || 1);
    }
  };

  // ---- controls fade out after inactivity (not while a menu or the notes drawer is open) ----
  const poke = () => {
    setShowControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!menuRef.current && !notesDrawerRef.current) setShowControls(false);
    }, 3000);
  };

  const seek = (t: number) => {
    if (!data || fatal) return;
    const clamped = Math.max(0, duration > 0 ? Math.min(t, duration - 0.5) : t);
    lastPos.current = clamped;
    if (mode === "direct") {
      if (videoRef.current) videoRef.current.currentTime = clamped;
    } else {
      save();
      switchMode(mode, clamped);
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const markDoneLocal = (value: boolean) => {
    // updates the ✓ in the sidebar and the button without waiting for a refetch
    setData((d) => (d ? { ...d, completed: value ? 1 : 0 } : d));
    setCourse((c) =>
      c
        ? {
            ...c,
            sections: c.sections.map((s) => ({
              ...s,
              lessons: s.lessons.map((l) => (l.id === data?.id ? { ...l, completed: value ? 1 : 0 } : l))
            }))
          }
        : c
    );
  };

  const toggleWatched = () => {
    if (!data) return;
    const value = !data.completed;
    void saveProgress(data.id, lastPos.current, value);
    markDoneLocal(value);
  };

  const onEnded = () => {
    if (!data) return;
    void saveProgress(data.id, duration || effTime, true);
    markDoneLocal(true);
    if (autoNext && data.next) navigate(`/lesson/${data.next.id}`);
  };

  const setCompatMode = (on: boolean) => {
    setCompat(on);
    compatRef.current = on;
    if (!data) return;
    save();
    switchMode(on ? "transcode" : data.directPlay ? "direct" : "remux", lastPos.current);
  };

  const chooseLang = (lang: string | null) => {
    setSubLang(lang);
    if (lang) localStorage.setItem(SUB_PREF_KEY, lang);
    else localStorage.removeItem(SUB_PREF_KEY);
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        return;
      if (e.code === "Space" || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight" || e.key === "l") seek(effTime + 10);
      else if (e.key === "ArrowLeft" || e.key === "j") seek(effTime - 10);
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        setVolume((v) => Math.min(MAX_VOLUME, +(v + 0.1).toFixed(2)));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setVolume((v) => Math.max(0, +(v - 0.1).toFixed(2)));
      } else if (e.key === "m") toggleMute();
      else if (e.key === "f") toggleFullscreen();
      else if (e.key === "n") {
        setNotesDrawer((v) => !v);
        setShowControls(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  if (error) return <div className="page center-msg">{t("course.failed_to_load", { error })}</div>;
  if (!data) return <div className="page center-msg">{t("course.loading")}</div>;

  const totalLessons = course ? course.sections.reduce((n, s) => n + s.lessons.length, 0) : 0;

  // ---- timeline ----
  const shownTime = drag ?? effTime;
  const playedPct = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  const timeAt = (clientX: number) => {
    const rect = seekWrapRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const updateHover = (clientX: number) => {
    const rect = seekWrapRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const half = (tp ? tp.tileW / 2 : 42) + 6;
    const x = Math.min(Math.max(frac * rect.width, half), Math.max(half, rect.width - half));
    setHover({ x, time: frac * duration });
  };

  return (
    <div className="player-page">
      <div className="player-topbar">
        <Link to={`/course/${data.course.id}`} className="back-link">
          {t("player.back_to_course")}
        </Link>
        <div className="topbar-nav">
          <button
            className="round-btn"
            onClick={() => data.prev && navigate(`/lesson/${data.prev.id}`)}
            disabled={!data.prev}
            title={data.prev ? t("player.previous_lesson_title", { title: data.prev.title }) : t("player.first_lesson")}
          >
            <IconChevronLeft size={18} />
          </button>
          <button
            className="round-btn"
            onClick={() => data.next && navigate(`/lesson/${data.next.id}`)}
            disabled={!data.next}
            title={data.next ? t("player.next_lesson_title", { title: data.next.title }) : t("player.last_lesson")}
          >
            <IconChevronRight size={18} />
          </button>
        </div>
      </div>

      <div className="player-layout">
        {/* ---- left column: title + player + materials ---- */}
        <div className="player-main">
          <div className="player-title-row">
            <h1 className="player-title">{data.title}</h1>
            <button
              className={data.completed ? "btn-watched active" : "btn-watched"}
              onClick={toggleWatched}
              title={data.completed ? t("player.mark_unwatched") : t("player.mark_watched")}
            >
              <IconCheck size={14} />
              {data.completed ? t("player.watched") : t("player.mark_watched")}
            </button>
          </div>

          <div
            ref={wrapRef}
            className={showControls ? "video-wrap" : "video-wrap hide-cursor"}
            onMouseMove={poke}
            onClick={poke}
          >
            <video
              key={`${src}#${reloadKey}`}
              ref={videoRef}
              src={src}
              autoPlay={playing || offset > 0 || pendingResume.current > 0 || reloadKey > 0}
              crossOrigin="anonymous"
              onClick={() => (menu ? setMenu(null) : togglePlay())}
              onDoubleClick={toggleFullscreen}
              onPlay={() => {
                setPlaying(true);
                save(); // makes sure a progress row exists right after the first play
                poke();
              }}
              onPause={() => {
                setPlaying(false);
                save();
                setShowControls(true);
              }}
              onTimeUpdate={(e) => {
                const t = e.currentTarget.currentTime;
                setCurTime(t);
                lastPos.current = mode === "direct" ? t : offset + t;
              }}
              onLoadStart={() => setWaiting(true)}
              onCanPlay={() => setWaiting(false)}
              onPlaying={() => setWaiting(false)}
              onWaiting={() => setWaiting(true)}
              onSeeked={() => setWaiting(false)}
              onProgress={(e) => {
                const b = e.currentTarget.buffered;
                if (b.length > 0) setBuffered((mode === "direct" ? 0 : offset) + b.end(b.length - 1));
              }}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setVideoDur(v.duration);
                applyVolume(v, volume);
                v.playbackRate = rate;
                if (mode === "direct" && pendingResume.current > 0) {
                  v.currentTime = pendingResume.current;
                  pendingResume.current = 0;
                }
              }}
              onEnded={onEnded}
              onError={onVideoError}
            >
              {data.subtitles.map((s) => (
                <track key={s.id} kind="subtitles" label={s.lang} src={`/api/subtitles/${s.id}`} />
              ))}
            </video>

            {waiting && !fatal && <div className="player-spinner" />}

            {fatal && (
              <div className="player-error">
                <div className="player-error-title">{t("player.fatal_error")}</div>
                <button
                  className="btn-primary"
                  onClick={() =>
                    switchMode(compat ? "transcode" : data.directPlay ? "direct" : "remux", lastPos.current)
                  }
                >
                  {t("player.try_again")}
                </button>
              </div>
            )}

            {subLang && cueLines.length > 0 && (
              <div
                className={showControls ? "sub-overlay raised" : "sub-overlay"}
                style={{ fontSize: subStyle.size }}
              >
                {cueLines.map((line, i) => (
                  <span
                    key={i}
                    className="sub-line"
                    style={{
                      color: subStyle.color,
                      background: `rgba(0, 0, 0, ${subStyle.bg})`,
                      textShadow: subStyle.outline
                        ? "2px 2px 0 #000, -2px 2px 0 #000, 2px -2px 0 #000, -2px -2px 0 #000"
                        : undefined
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitizeCue(line) }}
                  />
                ))}
              </div>
            )}

            <div className={showControls ? "controls" : "controls controls-hidden"}>
              <div
                ref={seekWrapRef}
                className={drag !== null ? "seekbar-wrap dragging" : "seekbar-wrap"}
                onPointerDown={(e) => {
                  if (duration <= 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag(timeAt(e.clientX));
                }}
                onPointerMove={(e) => {
                  updateHover(e.clientX);
                  if (drag !== null) setDrag(timeAt(e.clientX));
                }}
                onPointerUp={() => {
                  if (drag !== null) {
                    seek(drag);
                    setDrag(null);
                  }
                }}
                onPointerLeave={() => setHover(null)}
              >
                <div className="seekbar-track">
                  <div className="seekbar-buffer" style={{ width: `${bufferedPct}%` }} />
                  <div className="seekbar-fill" style={{ width: `${playedPct}%` }} />
                  <div className="seekbar-thumb" style={{ left: `${playedPct}%` }} />
                </div>
                {duration > 0 &&
                  notes
                    .filter((n) => n.lessonId === data.id && n.timeSec != null)
                    .map((n) => (
                      <div
                        key={n.id}
                        className="note-marker"
                        style={{ left: `${(n.timeSec! / duration) * 100}%` }}
                        // without this the seekbar pointer capture swallows the click as a drag-seek
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          seek(n.timeSec!);
                          setOpenNoteId(n.id);
                          setNotesDrawer(true);
                        }}
                        onPointerEnter={() => setMarkerHover(n.id)}
                        onPointerLeave={() => setMarkerHover(null)}
                      >
                        <IconNote size={11} />
                        {markerHover === n.id && (
                          <div className="note-marker-pop">
                            <span className="note-marker-time">{fmtClock(n.timeSec!)}</span>
                            <span className="note-marker-text">
                              {n.text.trim()
                                ? n.text.slice(0, 90) + (n.text.length > 90 ? "…" : "")
                                : "(drawing)"}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                {hover && (
                  <div className="seek-preview" style={{ left: hover.x }}>
                    {tp &&
                      (() => {
                        const idx = Math.max(0, Math.min(tp.frames - 1, Math.floor(hover.time / tp.interval)));
                        const perSheet = tp.cols * tp.rows;
                        const sheet = Math.floor(idx / perSheet);
                        const col = (idx % perSheet) % tp.cols;
                        const row = Math.floor((idx % perSheet) / tp.cols);
                        return (
                          <div
                            className="seek-preview-img"
                            style={{
                              width: tp.tileW,
                              height: tp.tileH,
                              backgroundImage: `url(/api/trickplay/${data.id}/${sheet})`,
                              backgroundPosition: `-${col * tp.tileW}px -${row * tp.tileH}px`
                            }}
                          />
                        );
                      })()}
                    <div className="seek-preview-time">{fmtClock(hover.time)}</div>
                  </div>
                )}
              </div>
              <div className="controls-row">
                <div className="controls-left">
                  <button onClick={() => data.prev && navigate(`/lesson/${data.prev.id}`)} disabled={!data.prev} title={t("player.previous_lesson")}>
                    <IconSkipPrev size={19} />
                  </button>
                  <button className="play-btn" onClick={togglePlay} title={playing ? t("player.pause") : t("player.play")}>
                    {playing ? <IconPause size={24} /> : <IconPlay size={24} />}
                  </button>
                  <button onClick={() => data.next && navigate(`/lesson/${data.next.id}`)} disabled={!data.next} title={t("player.next_lesson")}>
                    <IconSkipNext size={19} />
                  </button>
                  <button onClick={() => seek(effTime - 10)} title={t("player.back_10s")}>
                    <IconRewind10 size={21} />
                  </button>
                  <button onClick={() => seek(effTime + 10)} title={t("player.forward_10s")}>
                    <IconForward10 size={21} />
                  </button>
                  <div className="ctrl-volume">
                    <button onClick={toggleMute} title={volume === 0 ? t("player.unmute") : t("player.mute")}>
                      {volume === 0 ? <IconVolumeMute size={20} /> : <IconVolume size={20} />}
                    </button>
                    <input
                      className="volume"
                      type="range"
                      min={0}
                      max={MAX_VOLUME}
                      step={0.05}
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      style={{
                        background:
                          volume > 1
                            ? `linear-gradient(to right, #fff ${100 / MAX_VOLUME}%, var(--accent) ${100 / MAX_VOLUME}%, var(--accent) ${(volume / MAX_VOLUME) * 100}%, rgba(255,255,255,0.25) ${(volume / MAX_VOLUME) * 100}%)`
                            : `linear-gradient(to right, #fff ${(volume / MAX_VOLUME) * 100}%, rgba(255,255,255,0.25) ${(volume / MAX_VOLUME) * 100}%)`
                      }}
                      title={t("player.volume_percent", { percent: Math.round(volume * 100) })}
                    />
                    {volume > 1 && <span className="volume-boost">{Math.round(volume * 100)}%</span>}
                  </div>
                  <span className="time-label">
                    {fmtClock(effTime)} / {fmtClock(duration)}
                  </span>
                </div>
                <div className="controls-right">
                  {data.subtitles.length > 0 && (
                    <div className="menu-anchor" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={subLang ? "cc-on" : menu === "cc" || menu === "substyle" ? "active" : undefined}
                        onClick={() => setMenu(menu === "cc" || menu === "substyle" ? null : "cc")}
                        title={t("player.subtitles")}
                      >
                        <IconCC size={20} />
                      </button>
                      {menu === "cc" && (
                        <div className="menu">
                          <div className="menu-label">{t("player.subtitles")}</div>
                          <button className="menu-item" onClick={() => chooseLang(null)}>
                            <span className="mi-check">{subLang === null && <IconCheck size={14} />}</span>
                            {t("player.off")}
                          </button>
                          {data.subtitles.map((s) => (
                            <button key={s.id} className="menu-item" onClick={() => chooseLang(s.lang)}>
                              <span className="mi-check">{subLang === s.lang && <IconCheck size={14} />}</span>
                              {s.lang}
                            </button>
                          ))}
                          <div className="menu-sep" />
                          <button className="menu-item" onClick={() => setMenu("substyle")}>
                            <span className="mi-check">
                              <IconTypography size={15} />
                            </span>
                            {t("player.subtitle_style")}
                            <span className="mi-arrow">
                              <IconChevronRight size={13} />
                            </span>
                          </button>
                        </div>
                      )}
                      {menu === "substyle" && (
                        <div className="menu sub-panel">
                          <button className="menu-item menu-back" onClick={() => setMenu("cc")}>
                            <IconChevronLeft size={14} /> {t("player.subtitle_style")}
                          </button>
                          <label className="sub-panel-row">
                            <span>{t("player.size")}</span>
                            <input
                              type="range"
                              min={14}
                              max={42}
                              step={1}
                              value={subStyle.size}
                              onChange={(e) => updateSubStyle({ size: Number(e.target.value) })}
                            />
                            <b>{subStyle.size}</b>
                          </label>
                          <div className="sub-panel-row">
                            <span>{t("player.color")}</span>
                            <span className="sub-swatches">
                              {SUB_COLORS.map((c) => (
                                <button
                                  key={c}
                                  className={subStyle.color === c ? "swatch active" : "swatch"}
                                  style={{ background: c }}
                                  onClick={() => updateSubStyle({ color: c })}
                                  title={c}
                                />
                              ))}
                            </span>
                          </div>
                          <label className="sub-panel-row">
                            <span>{t("player.background")}</span>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={subStyle.bg}
                              onChange={(e) => updateSubStyle({ bg: Number(e.target.value) })}
                            />
                            <b>{Math.round(subStyle.bg * 100)}%</b>
                          </label>
                          <button
                            className="menu-item"
                            onClick={() => updateSubStyle({ outline: !subStyle.outline })}
                          >
                            <span className="menu-item-text">{t("player.outline")}</span>
                            <span className={subStyle.outline ? "switch on" : "switch"}>
                              <span className="switch-knob" />
                            </span>
                          </button>
                          <div className="sub-panel-note">{t("player.applies_to_all")}</div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="menu-anchor" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={menu === "settings" ? "active" : undefined}
                      onClick={() => setMenu(menu === "settings" ? null : "settings")}
                      title={t("player.settings")}
                    >
                      <IconSettings size={20} />
                    </button>
                    {menu === "settings" && (
                      <div className="menu">
                        <div className="menu-label">{t("player.speed")}</div>
                        <div className="rate-row">
                          {RATES.map((r) => (
                            <button
                              key={r}
                              className={r === rate ? "rate-pill active" : "rate-pill"}
                              onClick={() => setRate(r)}
                            >
                              {r === 1 ? t("player.normal") : `${r}x`}
                            </button>
                          ))}
                        </div>
                        <div className="menu-sep" />
                        <button
                          className="menu-item"
                          onClick={() => {
                            const v = !autoNext;
                            setAutoNext(v);
                            localStorage.setItem(AUTONEXT_KEY, v ? "1" : "0");
                          }}
                        >
                          <span className="menu-item-text">{t("player.autoplay_next")}</span>
                          <span className={autoNext ? "switch on" : "switch"}>
                            <span className="switch-knob" />
                          </span>
                        </button>
                        <button className="menu-item" onClick={() => setCompatMode(!compat)}>
                          <span className="menu-item-text">
                            {t("player.compatibility_mode")}
                            <small>{t("player.compatibility_desc")}</small>
                          </span>
                          <span className={compat ? "switch on" : "switch"}>
                            <span className="switch-knob" />
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    className={notesDrawer ? "active" : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNotesDrawer((v) => !v);
                    }}
                    title={t("player.notes")}
                  >
                    <IconNote size={19} />
                  </button>
                  <button onClick={toggleFullscreen} title={t("player.fullscreen")}>
                    <IconFullscreen size={19} />
                  </button>
                </div>
              </div>
            </div>

            {/* notes drawer: lives inside the wrapper so it works in fullscreen */}
            {notesDrawer && (
              <div
                className="notes-drawer"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="notes-drawer-head">
                  <span>{t("player.notes")}</span>
                  <button className="note-tool" onClick={() => setNotesDrawer(false)} title={t("player.close")}>
                    <IconX size={15} />
                  </button>
                </div>
                <NotesPanel
                  compact
                  courseId={data.course.id}
                  notes={notes}
                  onRefresh={refreshNotes}
                  currentLessonId={data.id}
                  getCurrentTime={() => lastPos.current}
                  onSeek={seek}
                  onOpenEditor={() => videoRef.current?.pause()}
                  openNoteId={openNoteId}
                  onOpenNoteHandled={() => setOpenNoteId(null)}
                />
              </div>
            )}
          </div>

          {/* ---- materials below the player ---- */}
          {course && <Materials materials={course.materials} title={t("player.course_materials")} />}
        </div>

        {/* ---- right column: course lessons ---- */}
        <aside className="player-sidebar">
          <div className="sidebar-header">
            <div className="sidebar-course">{data.course.title}</div>
            {totalLessons > 0 && <div className="sidebar-count">{t("player.total_lessons", { count: totalLessons })}</div>}
          </div>
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "lessons" ? "sidebar-tab active" : "sidebar-tab"}
              onClick={() => setSidebarTab("lessons")}
            >
              {t("player.lessons_tab")}
            </button>
            <button
              className={sidebarTab === "notes" ? "sidebar-tab active" : "sidebar-tab"}
              onClick={() => setSidebarTab("notes")}
            >
              {t("player.notes_tab")}{notes.length > 0 ? ` (${notes.length})` : ""}
            </button>
          </div>
          {sidebarTab === "notes" && (
            <div className="sidebar-notes">
              <NotesPanel
                compact
                courseId={data.course.id}
                notes={notes}
                onRefresh={refreshNotes}
                currentLessonId={data.id}
                getCurrentTime={() => lastPos.current}
                onSeek={seek}
                onOpenEditor={() => videoRef.current?.pause()}
              />
            </div>
          )}
          <div className="sidebar-list" style={sidebarTab === "notes" ? { display: "none" } : undefined}>
            {course?.sections.map((section, i) => {
              const hasSections = course.sections.length > 1 || section.title !== null;
              const containsCurrent = section.lessons.some((l) => l.id === data.id);
              const list = (
                <ul className="sidebar-lessons">
                  {section.lessons.map((l) => {
                    const isCurrent = l.id === data.id;
                    return (
                      <li key={l.id}>
                        <Link
                          to={`/lesson/${l.id}`}
                          className={isCurrent ? "sidebar-lesson current" : "sidebar-lesson"}
                        >
                          <span className={l.completed ? "lesson-icon done" : "lesson-icon"}>
                            {l.completed ? (
                              <IconCheck size={13} />
                            ) : isCurrent ? (
                              <IconPlay size={12} />
                            ) : (
                              <IconPlayOutline size={12} />
                            )}
                          </span>
                          <span className="lesson-thumb small">
                            <img
                              loading="lazy"
                              src={`/api/thumb/lesson/${l.id}`}
                              alt=""
                              onError={(e) => e.currentTarget.parentElement?.classList.add("empty")}
                            />
                          </span>
                          <span className="sidebar-lesson-title">{l.title}</span>
                          <span className="sidebar-lesson-dur">{fmtDuration(l.duration)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              );
              if (!hasSections) return <div key={i}>{list}</div>;
              return (
                <details key={i} className="sidebar-section" open={containsCurrent}>
                  <summary>
                    <span className="sidebar-section-title">{section.title ?? t("player.lessons_tab")}</span>
                    <span className="section-meta">
                      {section.lessons.filter((l) => l.completed).length}/{section.lessons.length}
                    </span>
                  </summary>
                  {list}
                </details>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
