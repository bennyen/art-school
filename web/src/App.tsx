import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
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

  const toggleLang = () => {
    i18n.changeLanguage(i18n.language === "en" ? "pt-BR" : "en");
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
            <button className="btn-ghost lang-toggle" onClick={toggleLang}>
              {i18n.language === "en" ? "PT" : "EN"}
            </button>
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
