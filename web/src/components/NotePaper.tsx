import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NoteRow, fmtClock, noteDrawingUrl } from "../api";
import { IconCheck, IconEraser, IconPencil, IconTrash, IconX } from "./Icons";

// Fixed body size: the flattened PNG has to line up with the text in every
// context (player sidebar, player drawer, course page modal).
const PAPER_W = 400;
const PAPER_H = 300;
const SCALE = 2; // 2x canvas for sharpness

const PEN_COLORS = ["#1a1a1a", "#dc2626", "#2563eb", "#8b5cf6"];

interface NotePaperProps {
  note: NoteRow | null; // null = creating a new one
  /** title shown in the header (lesson + timestamp, or "Course note") */
  heading: string;
  timeSec?: number | null;
  readOnly?: boolean;
  saving?: boolean;
  /** drawing: undefined = untouched; null = clear it; Blob = new flattened PNG */
  onSave: (text: string, drawing: Blob | null | undefined) => void;
  onDelete?: () => void;
  onClose: () => void;
  headerExtra?: React.ReactNode;
}

export default function NotePaper({
  note,
  heading,
  timeSec,
  readOnly,
  saving,
  onSave,
  onDelete,
  onClose,
  headerExtra
}: NotePaperProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(note?.text ?? "");
  const [drawMode, setDrawMode] = useState(false);
  // once started, the canvas stays mounted until save (otherwise unsaved strokes would be lost)
  const [canvasStarted, setCanvasStarted] = useState(false);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [eraser, setEraser] = useState(false);
  // drawing: undefined = untouched; null = cleared; true = canvas was drawn on
  const dirtyRef = useRef<null | true | undefined>(undefined);
  const [cleared, setCleared] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingPtr = useRef<number | null>(null);

  const hasDrawing = Boolean(note?.hasDrawing) && !cleared;
  const drawingSrc = note && note.hasDrawing ? noteDrawingUrl(note.id, note.updatedAt) : null;

  // when drawing starts, flatten the existing PNG onto the canvas to keep drawing over it
  useEffect(() => {
    if (!canvasStarted || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PAPER_W * SCALE, PAPER_H * SCALE);
    if (drawingSrc && !cleared) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, PAPER_W * SCALE, PAPER_H * SCALE);
      img.src = drawingSrc;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasStarted]);

  const strokeTo = (e: React.PointerEvent<HTMLCanvasElement>, begin: boolean) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * PAPER_W * SCALE;
    const y = ((e.clientY - rect.top) / rect.height) * PAPER_H * SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (eraser) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = 28;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = penColor;
      ctx.lineWidth = 5;
    }
    if (begin) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      // single dot (click without dragging)
      ctx.lineTo(x + 0.01, y + 0.01);
    } else {
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    dirtyRef.current = true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingPtr.current = e.pointerId;
    strokeTo(e, true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingPtr.current !== e.pointerId) return;
    strokeTo(e, false);
  };
  const onPointerUp = () => {
    drawingPtr.current = null;
  };

  const clearDrawing = () => {
    const ctx = canvasRef.current?.getContext("2d");
    ctx?.clearRect(0, 0, PAPER_W * SCALE, PAPER_H * SCALE);
    dirtyRef.current = null;
    setCleared(true);
  };

  const handleSave = () => {
    if (dirtyRef.current === true && canvasRef.current) {
      canvasRef.current.toBlob((blob) => onSave(text, blob ?? undefined), "image/png");
    } else {
      onSave(text, dirtyRef.current === null ? null : undefined); // null (cleared) or undefined (untouched)
    }
  };

  return (
    <div
      className="note-paper"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="note-paper-head">
        <span className="note-paper-title">
          {heading}
          {timeSec != null && <span className="note-paper-time">{fmtClock(timeSec)}</span>}
        </span>
        <span className="note-paper-actions">
          {headerExtra}
          {!readOnly && onDelete && (
            <button className="note-tool" onClick={onDelete} title={t("note_paper.delete_note")}>
              <IconTrash size={15} />
            </button>
          )}
          <button className="note-tool" onClick={onClose} title={t("note_paper.close")}>
            <IconX size={15} />
          </button>
        </span>
      </div>

      <div className="note-paper-body">
        {readOnly ? (
          <div className="note-paper-text note-paper-read">{text}</div>
        ) : (
          <textarea
            className="note-paper-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("note_paper.placeholder")}
            disabled={drawMode}
            autoFocus={!drawMode}
          />
        )}
        {hasDrawing && !canvasStarted && drawingSrc && (
          <img className="note-paper-drawing" src={drawingSrc} alt="" draggable={false} />
        )}
        {canvasStarted && (
          <canvas
            ref={canvasRef}
            className="note-canvas"
            style={drawMode ? undefined : { pointerEvents: "none", cursor: "default" }}
            width={PAPER_W * SCALE}
            height={PAPER_H * SCALE}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
      </div>

      {!readOnly && (
        <div className="note-paper-foot">
          <span className="note-toolbar">
            <button
              className={`note-tool${drawMode && !eraser ? " active" : ""}`}
              onClick={() => {
                if (drawMode && !eraser) setDrawMode(false);
                else {
                  setDrawMode(true);
                  setCanvasStarted(true);
                  setEraser(false);
                }
              }}
              title={drawMode ? t("note_paper.exit_drawing") : t("note_paper.draw_over")}
            >
              <IconPencil size={15} />
            </button>
            {drawMode && (
              <>
                {PEN_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`note-swatch${penColor === c && !eraser ? " active" : ""}`}
                    style={{ background: c }}
                    onClick={() => {
                      setPenColor(c);
                      setEraser(false);
                    }}
                    title={t("note_paper.pen_color")}
                  />
                ))}
                <button
                  className={`note-tool${eraser ? " active" : ""}`}
                  onClick={() => setEraser((v) => !v)}
                  title={t("note_paper.eraser")}
                >
                  <IconEraser size={15} />
                </button>
                <button className="note-tool" onClick={clearDrawing} title={t("note_paper.clear_drawing")}>
                  <IconTrash size={15} />
                </button>
              </>
            )}
          </span>
          <button className="btn-primary note-save" onClick={handleSave} disabled={saving}>
            <IconCheck size={15} />
            {saving ? t("note_paper.saving") : t("note_paper.save")}
          </button>
        </div>
      )}
    </div>
  );
}
