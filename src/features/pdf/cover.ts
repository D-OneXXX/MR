/**
 * PDF 封面生成。
 *
 * PDF 没有「首页图片」：书库封面由前端用 pdf.js 渲染第 1 页，再经
 * `put_pdf_thumbnail` 写回后端缓存（后端按固定边长 256 落 L2 缓存）。
 *
 * 并发保护：整座书库可能同时有几十张 PDF 卡片进入视口，因此这里用
 * 模块级队列把封面生成**串行化**——同一时刻只打开一份 PDF 文档，
 * 绝不一次性拉起几十个 pdf.js worker。
 */
import { api } from "@/lib/tauri";
import { openPdfDocument, releasePdfDocument } from "./document";
import { renderPdfPage } from "./render";

/** 封面边长（与后端 `pdf::PDF_COVER_EDGE` 一致）。 */
export const PDF_COVER_EDGE = 256;

/** 串行队列：保证同一时刻只有一个封面任务在跑。 */
let coverQueue: Promise<unknown> = Promise.resolve();

/** 去掉 data URL 前缀，只留 base64（后端要的是裸 base64）。 */
export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * 生成（并缓存）PDF 封面。
 *
 * 返回 data URL；失败时返回 null（调用方展示占位图，不打断书库）。
 */
export function ensurePdfCover(
  bookId: string,
  edge: number = PDF_COVER_EDGE,
): Promise<string | null> {
  const run = coverQueue.then(() => generateCover(bookId, edge));
  // 队列本身不能被单个任务的失败打断。
  coverQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 队列内部：真正渲染并写回缓存。 */
async function generateCover(
  bookId: string,
  edge: number,
): Promise<string | null> {
  let doc = null;
  try {
    doc = await openPdfDocument(bookId);
    const rendered = await renderPdfPage(
      doc,
      0,
      { width: edge, height: edge },
      "page",
    ).promise;
    await api.putPdfThumbnail(bookId, stripDataUrl(rendered.dataUrl));
    return rendered.dataUrl;
  } catch {
    // 封面失败不影响阅读：调用方回落到占位图。
    return null;
  } finally {
    if (doc) releasePdfDocument(bookId);
  }
}
