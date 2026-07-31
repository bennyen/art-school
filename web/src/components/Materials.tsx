import { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { fmtSize, MaterialKind, MaterialRow } from "../api";
import {
  IconArchive,
  IconAudio,
  IconBrush,
  IconDownload,
  IconEye,
  IconFile,
  IconFileText,
  IconImage,
  IconPalette,
  IconPaperclip,
  IconPlay,
  IconVideo
} from "./Icons";

const KIND_ICONS: Record<MaterialKind, ComponentType<{ size?: number }>> = {
  video: IconVideo,
  image: IconImage,
  pdf: IconFileText,
  text: IconFileText,
  html: IconFileText,
  audio: IconAudio,
  brush: IconBrush,
  psd: IconPalette,
  clip: IconPalette,
  archive: IconArchive,
  other: IconFile
};

const KIND_KEYS: Record<MaterialKind, string> = {
  video: "materials.video",
  image: "materials.image",
  pdf: "materials.pdf",
  text: "materials.text",
  html: "materials.html",
  audio: "materials.audio",
  brush: "materials.brushes",
  psd: "materials.photoshop",
  clip: "materials.clip_studio",
  archive: "materials.archive",
  other: "materials.file"
};

export default function Materials({ materials, title }: { materials: MaterialRow[]; title: string }) {
  const { t } = useTranslation();
  if (materials.length === 0) return null;
  return (
    <details className="section player-materials">
      <summary>
        <span className="section-title with-icon">
          <IconPaperclip size={16} /> {title}
        </span>
        <span className="section-meta">{t("materials.files_count", { count: materials.length })}</span>
      </summary>
      <ul className="material-list">
        {materials.map((m) => {
          const Icon = KIND_ICONS[m.kind] ?? KIND_ICONS.other;
          const labelKey = KIND_KEYS[m.kind] ?? KIND_KEYS.other;
          const label = t(labelKey);
          return (
            <li key={m.id}>
              <span className="material-icon" title={label}>
                <Icon size={18} />
              </span>
              <span className="material-name">{m.name}</span>
              <span className="material-kind">{label}</span>
              <span className="material-size">{fmtSize(m.size)}</span>
              <span className="material-actions">
                {m.viewable && (
                  <a
                    className="material-btn"
                    href={`/api/materials/${m.id}/view`}
                    target="_blank"
                    rel="noreferrer"
                    title={m.kind === "video" ? t("materials.play_browser") : t("materials.view_browser")}
                  >
                    {m.kind === "video" ? <IconPlay size={13} /> : <IconEye size={13} />}
                    {m.kind === "video" ? t("materials.play") : t("materials.view")}
                  </a>
                )}
                <a className="material-btn" href={`/api/materials/${m.id}`} download title={t("materials.download_file")}>
                  <IconDownload size={13} />
                  {t("materials.download")}
                </a>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
