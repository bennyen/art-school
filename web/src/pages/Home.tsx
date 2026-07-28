import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, CourseSummary, fmtClock, fmtDuration, HomeData } from "../api";
import { IconArchive, IconCheck, IconPlay, IconUser } from "../components/Icons";

/** "Movie poster" card: portrait, with tags and stats — used in the My courses row */
function PosterCard({ c }: { c: CourseSummary }) {
  return (
    <Link to={`/course/${c.id}`} className="poster-card">
      <img src={`/api/thumb/${c.id}`} alt={c.title} loading="lazy" />
      <div className="poster-grad" />
      {c.category && <span className="badge poster-badge">{c.category}</span>}
      {c.progressPct === 100 && (
        <span className="badge badge-done poster-done">
          <IconCheck size={11} /> Completed
        </span>
      )}
      <div className="poster-body">
        <h3>{c.title}</h3>
        {c.teacher && (
          <span className="poster-teacher">
            <IconUser size={12} /> {c.teacher}
          </span>
        )}
        <span className="poster-meta">
          {c.lessonCount} lessons
          {c.sectionCount > 1 ? ` · ${c.sectionCount} modules` : ""}
          {c.totalDuration ? ` · ${fmtDuration(c.totalDuration)}${c.durationPartial ? "+" : ""}` : ""}
        </span>
        <div className="progress-bar poster-progress">
          <div style={{ width: `${c.progressPct}%` }} />
        </div>
      </div>
    </Link>
  );
}

/** Compact card: small 16:9 thumbnail — used in the per-category rows */
function CompactCard({ c }: { c: CourseSummary }) {
  return (
    <Link to={`/course/${c.id}`} className="compact-card">
      <div className="compact-thumb">
        <img src={`/api/thumb/${c.id}`} alt={c.title} loading="lazy" />
        {c.progressPct === 100 && (
          <span className="badge badge-done compact-done">
            <IconCheck size={10} />
          </span>
        )}
        <div className="mini-progress">
          <div style={{ width: `${c.progressPct}%` }} />
        </div>
      </div>
      <span className="compact-title">{c.title}</span>
      <span className="compact-meta">
        {c.completedCount}/{c.lessonCount} lessons
        {c.totalDuration ? ` · ${fmtDuration(c.totalDuration)}${c.durationPartial ? "+" : ""}` : ""}
      </span>
    </Link>
  );
}

export default function Home() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<HomeData>("/api/courses").then(setData).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page center-msg">Failed to load: {error}</div>;
  if (!data) return <div className="page center-msg">Loading...</div>;

  const ready = data.courses.filter((c) => c.status === "ready");
  const notReady = data.courses.filter((c) => c.status !== "ready");
  const categories = [...new Set(ready.map((c) => c.category).filter((c): c is string => c !== null))].sort((a, b) =>
    a.localeCompare(b)
  );

  return (
    <div className="page">
      {/* ---- continue watching: simple YouTube-style card ---- */}
      {data.continueWatching.length > 0 && (
        <section>
          <h2 className="row-title">Continue watching</h2>
          <div className="scroll-row continue-row">
            {data.continueWatching.map((item) => (
              <Link key={item.lessonId} to={`/lesson/${item.lessonId}`} className="continue-card">
                <div className="continue-thumb">
                  <img src={`/api/thumb/lesson/${item.lessonId}`} alt="" loading="lazy" />
                  <span className="play-badge">
                    <IconPlay size={36} />
                  </span>
                  {item.duration ? (
                    <>
                      <span className="dur-badge">{fmtClock(item.duration)}</span>
                      <div className="mini-progress">
                        <div style={{ width: `${Math.min(100, (item.position / item.duration) * 100)}%` }} />
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="continue-info">
                  <span className="continue-lesson">{item.lessonTitle}</span>
                  <span className="continue-course">{item.courseTitle}</span>
                  {item.isNext ? (
                    <span className="continue-time next">Next lesson</span>
                  ) : (
                    <span className="continue-time">
                      {fmtClock(item.position)}
                      {item.duration ? ` / ${fmtClock(item.duration)}` : ""}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ---- my courses: portrait posters, one row with horizontal scroll ---- */}
      <section>
        <h2 className="row-title">My courses</h2>
        <div className="scroll-row poster-row">
          {ready.map((c) => (
            <PosterCard key={c.id} c={c} />
          ))}
        </div>
      </section>

      {/* ---- one compact row per category ---- */}
      {categories.map((cat) => (
        <section key={cat}>
          <h2 className="row-title">Courses in {cat}</h2>
          <div className="scroll-row compact-row">
            {ready
              .filter((c) => c.category === cat)
              .map((c) => (
                <CompactCard key={c.id} c={c} />
              ))}
          </div>
        </section>
      ))}

      {/* ---- not ready ---- */}
      {notReady.length > 0 && (
        <section>
          <h2 className="row-title">Not ready</h2>
          <div className="scroll-row compact-row">
            {notReady.map((c) => (
              <div key={c.id} className="compact-card compact-disabled">
                <div className="compact-thumb banner-placeholder">
                  <span className="placeholder-icon">
                    <IconArchive size={36} />
                  </span>
                </div>
                <span className="compact-title">{c.title}</span>
                <span className="compact-meta">Extract the archives (.rar/.zip)</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
