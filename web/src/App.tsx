import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh, Logo } from "./components/Icons";

export default function App() {
  const { t } = useTranslation();
  const location = useLocation();
  const isPlayer = location.pathname.startsWith("/lesson/");
  const [scanning, setScanning] = useState(false);

  const rescan = async () => {
    setScanning(true);
    try {
      await fetch("/api/scan", { method: "POST" });
      window.location.reload();
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className={isPlayer ? "app app-player" : "app"}>
      {!isPlayer && (
        <header className="topbar">
          <Link to="/" className="brand">
            <Logo size={32} />
            <span className="brand-text">
              ART<em>SCHOOL</em>
            </span>
          </Link>
          <div className="topbar-actions">
            <button className="btn-ghost" onClick={rescan} disabled={scanning}>
              <IconRefresh size={15} />
              {scanning ? t("app.scanning") : t("app.rescan")}
            </button>
          </div>
        </header>
      )}
      <Outlet />
    </div>
  );
}
