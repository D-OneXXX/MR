import { useEffect } from "react";

interface Props {
  title: string;
  message?: string;
  /** 将被删除的路径清单（等宽小字、逐行列出）。 */
  paths?: string[];
  confirmText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 确认对话框（流体 v2 组件清单）：玻璃遮罩 + 200ms 缩放淡入，Esc = 取消。 */
export default function ConfirmDialog({
  title,
  message,
  paths,
  confirmText = "确认",
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-mask"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h4>{title}</h4>
        {message ? <p>{message}</p> : null}
        {paths && paths.length > 0 ? (
          <p className="paths">{paths.join("\n")}</p>
        ) : null}
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
