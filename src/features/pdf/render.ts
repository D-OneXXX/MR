/**
 * PDF 页面渲染。
 *
 * 渲染结果转成 JPEG data URL，交给阅读器现有的 `<img>` 渲染链路：
 * - 不需要新的 CSP（`img-src` 本来就允许 `data:`）；
 * - 内存画像与既有 JPEG 页管线一致（一张图 ≈ 一页）。
 *
 * 尺寸策略：
 * - 适配模式决定基准缩放：`page` 整页可见，`width` 整宽（高度可溢出，
 *   靠拖拽查看）；
 * - 用户缩放只提升**渲染分辨率**（视觉缩放由阅读器的 CSS transform 负责），
 *   这样放大后依然清晰，又不会把布局尺寸算重；
 * - 画布上限：单边 ≤ 4096px、面积 ≤ 16Mpx，超出等比缩小（WebView2 纹理
 *   与内存都吃不消）。
 */
import type { PdfDocumentHandle } from "./document";

/** 适配模式：整页 / 整宽。 */
export type PdfFitMode = "page" | "width";

/** 单边上限（设备像素）。 */
export const PDF_MAX_EDGE = 4096;

/** 面积上限（设备像素²）。 */
export const PDF_MAX_AREA = 16_000_000;

/** 参考页在 scale=1 时的尺寸（PDF 点）。 */
export interface PdfPageBox {
  width: number;
  height: number;
}

/** 渲染目标框（设备像素）。 */
export interface PdfTargetBox {
  width: number;
  height: number;
}

export interface PdfFitInput {
  /** 参考页尺寸（scale=1）。 */
  page: PdfPageBox;
  /** 可用内容盒（CSS 像素）。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 适配模式。 */
  fit: PdfFitMode;
  /** 设备像素比。 */
  devicePixelRatio: number;
  /** 用户缩放倍数（视觉缩放由 CSS transform 负责，这里只提升分辨率）。 */
  zoom: number;
}

/** 计算渲染目标框（设备像素）。 */
export function computePdfTarget(input: PdfFitInput): PdfTargetBox {
  const { width: pw, height: ph } = input.page;
  if (!(pw > 0) || !(ph > 0)) return { width: 0, height: 0 };
  const dpr = Math.min(Math.max(input.devicePixelRatio || 1, 1), 3);
  const resolutionZoom = Math.min(Math.max(input.zoom || 1, 1), 2);
  const vw = Math.max(1, input.viewportWidth);
  const vh = Math.max(1, input.viewportHeight);
  let scale =
    input.fit === "width"
      ? (vw * dpr) / pw
      : Math.min((vw * dpr) / pw, (vh * dpr) / ph);
  scale *= resolutionZoom;
  scale = Math.min(scale, PDF_MAX_EDGE / Math.max(pw, ph));
  scale = Math.min(scale, Math.sqrt(PDF_MAX_AREA / (pw * ph)));
  return {
    width: Math.max(1, Math.round(pw * scale)),
    height: Math.max(1, Math.round(ph * scale)),
  };
}

/** 渲染结果。 */
export interface PdfRenderedPage {
  /** JPEG data URL。 */
  dataUrl: string;
  /** 实际位图宽（设备像素）。 */
  width: number;
  /** 实际位图高（设备像素）。 */
  height: number;
}

/** 渲染取消（翻页过快时被新任务取代）。 */
export class PdfRenderCancelled extends Error {
  constructor() {
    super("pdf-render-cancelled");
    this.name = "PdfRenderCancelled";
  }
}

/** 渲染句柄：可取消的渲染任务。 */
export interface PdfRenderHandle {
  promise: Promise<PdfRenderedPage>;
  cancel(): void;
}

/** 是否是「被取消」的渲染（取消不是错误，不弹提示）。 */
export function isPdfRenderCancelled(error: unknown): boolean {
  if (error instanceof PdfRenderCancelled) return true;
  const name =
    error && typeof error === "object"
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  return name === "RenderingCancelledException";
}

/**
 * 渲染一页。
 *
 * 取消语义：新任务取代旧任务时调用 `cancel()`；正在等待页面或正在光栅化
 * 都会被中止，绝不留下悬挂的 promise（避免 unhandled rejection）。
 */
export function renderPdfPage(
  doc: PdfDocumentHandle,
  index: number,
  target: PdfTargetBox,
  fit: PdfFitMode,
): PdfRenderHandle {
  let cancelled = false;
  let task: { cancel(): void } | null = null;
  const promise = (async (): Promise<PdfRenderedPage> => {
    const page = await doc.getPage(index);
    if (cancelled) throw new PdfRenderCancelled();
    const base = page.getViewport({ scale: 1 });
    let scale =
      fit === "width"
        ? target.width / base.width
        : Math.min(target.width / base.width, target.height / base.height);
    scale = Math.min(scale, PDF_MAX_EDGE / Math.max(base.width, base.height));
    scale = Math.min(
      scale,
      Math.sqrt(PDF_MAX_AREA / (base.width * base.height)),
    );
    scale = Math.max(scale, 0.01);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("pdf-render-unsupported");
    const renderTask = page.render({ canvas, canvasContext: context, viewport });
    task = renderTask;
    if (cancelled) {
      try {
        renderTask.cancel();
      } catch {
        /* 已结束 */
      }
    }
    try {
      await renderTask.promise;
    } finally {
      task = null;
    }
    if (cancelled) throw new PdfRenderCancelled();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    const width = canvas.width;
    const height = canvas.height;
    // 释放画布内存：位图已经变成 data URL。
    canvas.width = 0;
    canvas.height = 0;
    return { dataUrl, width, height };
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* 已结束 */
      }
    },
  };
}
