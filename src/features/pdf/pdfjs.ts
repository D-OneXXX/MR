/**
 * PDF.js 运行时（懒加载）。
 *
 * 设计要点：
 * - pdf.js 体积约 520KB，必须与首屏解耦：只有真正打开 PDF 时才
 *   `import()` 这份模块（动态 import 会单独切成一个 chunk）。
 * - worker 走 Vite 的 `?worker` 导入：产物是同源静态资源（MIME 正确），
 *   因此 `script-src 'self'` 的现有 CSP 不用放宽；不要改用 `?url`
 *   （`.mjs` 的 MIME 不受保证）。
 * - CMap / 标准 14 字体由 vite 插件拷进 `dist/pdf-assets/`，完全离线。
 * - 不传 `wasmUrl` / `iccUrl`：wasm 需要放宽 CSP 的 'wasm-unsafe-eval'，
 *   且 PDF 内嵌脚本沙箱（quickjs-eval）与「不执行文档脚本」冲突。
 */
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";

/** pdf.js 模块命名空间类型（与 legacy 构建的导出一一对应）。 */
export type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.min.mjs");

/** 预定义 CMap（东亚字体）静态资源前缀。 */
export const PDF_CMAP_URL = "/pdf-assets/cmaps/";

/** 标准 14 字体静态资源前缀。 */
export const PDF_STANDARD_FONT_URL = "/pdf-assets/standard_fonts/";

/**
 * range 传输分块大小（1 MiB）。
 *
 * 必须 ≤ 后端单次上限（4 MiB，见 `pdf::MAX_PDF_CHUNK_BYTES`）：超出会被
 * 钳制，返回的字节短于请求区间，pdf.js 的区间读取器会一直等待。
 */
export const PDF_RANGE_CHUNK_SIZE = 1_048_576;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** 懒加载 pdf.js：只有真正打开 PDF 时才会下载这份模块。 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.min.mjs");
  }
  return pdfjsPromise;
}

export interface PdfWorkerHandle {
  /** pdf.js 的 worker 包装（消息通道）。 */
  worker: InstanceType<PdfjsModule["PDFWorker"]>;
  /** 底层 Web Worker（负责终止，避免线程泄漏）。 */
  port: Worker;
}

/**
 * 每个文档一个独立 worker。
 *
 * pdf.js 的 `PDFWorker` 以 port 为键注册（`Cannot use more than one
 * PDFWorker per port`）；多个文档共用同一 port 时，先销毁的文档会把
 * worker 一起带走，连累还开着的文档。所以这里坚持「一文档一 worker」。
 */
export function createPdfWorker(pdfjs: PdfjsModule): PdfWorkerHandle {
  const port = new PdfWorker();
  // pdf.js 生成的 .d.ts 把构造参数里的 `port` 写成了 `null | undefined`
  // （类型生成器缺陷），这里按真实签名（Worker）纠正。
  const worker = new pdfjs.PDFWorker(
    { port } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0],
  );
  return { worker, port };
}

/** 终止并释放 worker（文档关闭时调用）。 */
export function disposePdfWorker(handle: PdfWorkerHandle | null): void {
  if (!handle) return;
  try {
    handle.worker.destroy();
  } catch {
    /* 已销毁 */
  }
  try {
    handle.port.terminate();
  } catch {
    /* 已终止 */
  }
}
