import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type BookInfo } from "../lib/tauri";
import BookDetail from "./BookDetail";

interface Props {
  book: BookInfo | null;
  /** 点击的封面矩形：shared-element 放大的起点（无则直接滑入）。 */
  originRect: DOMRect | null;
  onClose: () => void;
}

const EXIT_MS = 310;
const SETTLE_MS = 330; // 面板滑入落定后再飞封面

/**
 * 浮动详情 sheet（流体 v2）：右侧滑出 + 半透明遮罩，Esc/遮罩点击关闭，
 * 关闭即滑回。封面从点击位置放大进入（shared-element，WAAPI 实现）。
 */
export default function DetailSheet({ book, originRect, onClose }: Props) {
  const [render, setRender] = useState<BookInfo | null>(book);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [coverShown, setCoverShown] = useState(false);
  const [ghost, setGhost] = useState<{ src: string; from: DOMRect } | null>(null);
  const coverRef = useRef<HTMLImageElement | null>(null);
  const ghostRef = useRef<HTMLImageElement | null>(null);

  /* ---- 开/关状态机：关闭时先播放退出动画再卸载 ---- */
  useEffect(() => {
    if (book) {
      setRender(book);
      setClosing(false);
      setEntered(false);
      setCoverShown(false);
      setCoverSrc(null);
      setGhost(null);
      return;
    }
    if (render) {
      setClosing(true);
      const t = window.setTimeout(() => {
        setRender(null);
        setClosing(false);
        setGhost(null);
      }, EXIT_MS);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  /* ---- 面板滑入触发（首帧先挂 enter 态，下一帧移除以触发过渡） ---- */
  useEffect(() => {
    if (!render || closing) return;
    const id = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(id);
  }, [render, closing]);

  /* ---- 封面缩略图 ---- */
  useEffect(() => {
    if (!render) return;
    let alive = true;
    api
      .getThumbnail(render.id, 256)
      .then((img) => alive && setCoverSrc(img.dataUrl), () => {});
    return () => {
      alive = false;
    };
  }, [render]);

  /* ---- shared-element：面板落定后，封面从点击位置飞入 sheet 头部 ---- */
  useEffect(() => {
    if (!render || closing || !originRect || !coverSrc || coverShown) return;
    const t = window.setTimeout(() => setGhost({ src: coverSrc, from: originRect }), SETTLE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, closing, originRect, coverSrc, coverShown]);

  /* ---- ghost 已挂载：测量目标矩形并做 FLIP 飞行 ---- */
  useEffect(() => {
    if (!ghost) return;
    const el = ghostRef.current;
    const dest = coverRef.current?.getBoundingClientRect();
    if (!el || !dest || dest.width === 0) {
      setCoverShown(true);
      setGhost(null);
      return;
    }
    const dx = dest.left - ghost.from.left;
    const dy = dest.top - ghost.from.top;
    const sx = dest.width / ghost.from.width;
    const sy = dest.height / ghost.from.height;
    const anim = el.animate(
      [
        { transform: "translate(0px, 0px) scale(1, 1)" },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      ],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    anim.onfinish = () => {
      setCoverShown(true);
      setGhost(null);
    };
    return () => anim.cancel();
  }, [ghost]);

  /* ---- Esc 关闭 + 打开期间锁定页面滚动 ---- */
  useEffect(() => {
    if (!render) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [render, onClose]);

  if (!render) return null;

  return (
    <>
      <div
        className={`sheet-mask${closing ? " closing" : ""}`}
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`sheet-panel${!entered && !closing ? " enter" : ""}${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`详情：${render.title}`}
      >
        <button className="sheet-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">
          <X size={15} />
        </button>
        <div className="sheet-head">
          {coverSrc ? (
            <img
              ref={coverRef}
              className={`sheet-cover${coverShown ? " show" : ""}`}
              src={coverSrc}
              alt=""
              draggable={false}
            />
          ) : (
            <div className="sheet-cover" />
          )}
          <div className="sheet-head-body">
            <div className="sheet-title">{render.title}</div>
            {render.sourceType !== "local" && (
              <span className="badge mono" style={{ marginLeft: 8 }}>
                URL
              </span>
            )}
            <div className="hint mono">
              {render.currentPage} / {render.pageCount} 页
            </div>
          </div>
        </div>
        <BookDetail book={render} />
      </div>
      {ghost && (
        <img
          ref={ghostRef}
          className="sheet-ghost"
          src={ghost.src}
          alt=""
          draggable={false}
          style={{
            left: ghost.from.left,
            top: ghost.from.top,
            width: ghost.from.width,
            height: ghost.from.height,
          }}
        />
      )}
    </>
  );
}
