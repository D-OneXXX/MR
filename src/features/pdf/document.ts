/**
 * PDF 文档句柄与 LRU 缓存。
 *
 * - 打开：通过后端分块通道把本地 PDF 喂给 pdf.js（全程本地、无网络）。
 * - 缓存：最多同时持有 4 份文档，切换页签不必重新解析文件；超出容量
 *   时按 LRU 淘汰并真正释放 worker 线程。
 * - 释放：每个文档一个独立 worker（见 `createPdfWorker`），关闭时
 *   同时销毁 pdf.js 文档、消息通道与底层 Worker 线程。
 */
import { api } from "@/lib/tauri";
import {
  createPdfWorker,
  disposePdfWorker,
  loadPdfjs,
  PDF_CMAP_URL,
  PDF_RANGE_CHUNK_SIZE,
  PDF_STANDARD_FONT_URL,
  type PdfWorkerHandle,
} from "./pdfjs";
import { base64ToBytes, createRangeTransport } from "./transport";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/** 目录树节点（pdf.js outline 的安全子集）。 */
export interface PdfOutlineItem {
  /** 标题原文（PDF 自带，不做翻译）。 */
  title: string;
  /** 0 基页码；无法解析目标时为 null。 */
  pageIndex: number | null;
  /** 子节点。 */
  children: PdfOutlineItem[];
}

/** 已打开的 PDF 文档句柄。 */
export interface PdfDocumentHandle {
  readonly bookId: string;
  /** 真实页数（pdf.js 解析结果）。 */
  readonly numPages: number;
  /** 取页（0 基）。 */
  getPage(index: number): Promise<PDFPageProxy>;
  /** 取书签目录；无书签时返回空数组。 */
  getOutline(): Promise<PdfOutlineItem[]>;
  /** 释放文档与 worker。 */
  destroy(): Promise<void>;
}

/** 同时最多缓存的文档数（超过后按 LRU 淘汰）。 */
export const PDF_MAX_OPEN_DOCUMENTS = 4;

interface CacheEntry {
  handle: PdfDocumentHandle;
  /** 打开引用计数（阅读器持有期间 > 0）。 */
  refs: number;
  /** 最近使用时间（ms）。 */
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * 在途打开表：同一本书并发打开时只创建一份文档。
 *
 * 封面兜底（BookCard → ensurePdfCover）与阅读器可能同时打开同一本书；
 * 没有这张表时 `createDocument` 会跑两次 → 两个 pdf.js worker，
 * 且先创建的句柄会被后创建的覆盖，worker 永远不会被 terminate，
 * 于是 `PDF_MAX_OPEN_DOCUMENTS` 的上限形同虚设。
 */
const pending = new Map<string, Promise<PdfDocumentHandle>>();

/** 触碰条目：刷新引用计数与 LRU 顺序（Map 保持插入序）。 */
function touch(bookId: string, entry: CacheEntry): void {
  entry.refs += 1;
  entry.lastUsed = Date.now();
  cache.delete(bookId);
  cache.set(bookId, entry);
}

/** 打开（或复用）一份 PDF 文档。 */
export async function openPdfDocument(
  bookId: string,
): Promise<PdfDocumentHandle> {
  const cached = cache.get(bookId);
  if (cached) {
    touch(bookId, cached);
    return cached.handle;
  }
  const inflight = pending.get(bookId);
  if (inflight) {
    // 并发打开同一本书：复用同一次创建（同一个 worker），不新建文档。
    const handle = await inflight;
    const entry = cache.get(bookId);
    // 等待者也持有一次引用（创建者已经记了 1 次）。
    if (entry) touch(bookId, entry);
    return handle;
  }
  const created = createDocument(bookId).then(async (handle) => {
    cache.set(bookId, { handle, refs: 1, lastUsed: Date.now() });
    await evictOverflow();
    return handle;
  });
  pending.set(bookId, created);
  try {
    return await created;
  } finally {
    // 成功与失败都要清掉在途记录：失败后必须允许后续重试。
    if (pending.get(bookId) === created) pending.delete(bookId);
  }
}

/**
 * 释放一次引用。
 *
 * 文档不一定立刻销毁：留在 LRU 里可以让页签切换不必重新解析；超过
 * 容量（或没有引用时）才真正释放。
 */
export function releasePdfDocument(bookId: string): void {
  const entry = cache.get(bookId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = Date.now();
  void evictOverflow();
}

/** 立即销毁并移出缓存（书被删除 / 源失效时使用）。 */
export async function closePdfDocument(bookId: string): Promise<void> {
  const entry = cache.get(bookId);
  if (!entry) return;
  cache.delete(bookId);
  await entry.handle.destroy();
}

/** 当前缓存中的文档数（诊断用）。 */
export function pdfOpenDocumentCount(): number {
  return cache.size;
}

/**
 * 开发期诊断钩子：把「已打开文档数」暴露给 QA 断言 LRU 上限。
 *
 * 只在开发构建（`import.meta.env.DEV`）注册，生产构建会被完全摇掉，
 * 不构成任何遥测或对外接口。
 */
if (import.meta.env.DEV) {
  (
    globalThis as unknown as {
      __moyuPdf?: { openDocumentCount: () => number };
    }
  ).__moyuPdf = { openDocumentCount: pdfOpenDocumentCount };
}

/** 淘汰超出容量的文档（只淘汰没有引用的，避免拆掉正在读的文档）。 */
async function evictOverflow(): Promise<void> {
  if (cache.size <= PDF_MAX_OPEN_DOCUMENTS) return;
  const victims = [...cache.entries()]
    .filter(([, entry]) => entry.refs <= 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [bookId, entry] of victims) {
    if (cache.size <= PDF_MAX_OPEN_DOCUMENTS) break;
    cache.delete(bookId);
    await entry.handle.destroy();
  }
}

/** 真正打开一份文档：建 worker → 建区间传输 → 交给 pdf.js 解析。 */
async function createDocument(bookId: string): Promise<PdfDocumentHandle> {
  const pdfjs = await loadPdfjs();
  // 先探文件大小（offset 越界时后端返回空数据，不是错误）。
  const head = await api.getPdfChunk(bookId, 0, 0);
  const total = Number(head?.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("pdf-not-valid");
  }

  const workerHandle: PdfWorkerHandle = createPdfWorker(pdfjs);
  let transportError: unknown = null;
  const transport = createRangeTransport(
    pdfjs,
    total,
    null,
    async (begin, end) => {
      const chunk = await api.getPdfChunk(bookId, begin, end - begin);
      return base64ToBytes(chunk?.data ?? "");
    },
    (error) => {
      transportError = error;
    },
  );

  const loadingTask = pdfjs.getDocument({
    range: transport,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    disableAutoFetch: false,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_URL,
    useSystemFonts: false,
    // 自带 worker：不走 GlobalWorkerOptions，避免多文档共享同一 port。
    worker: workerHandle.worker,
  });

  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    await safeDestroy(loadingTask);
    disposePdfWorker(workerHandle);
    throw transportError ?? error;
  }

  const destroyed = { value: false };
  const handle: PdfDocumentHandle = {
    bookId,
    numPages: doc.numPages,
    getPage: (index: number) => doc.getPage(index + 1),
    getOutline: async () => {
      try {
        const raw = await doc.getOutline();
        return await readOutline(doc, raw ?? []);
      } catch {
        return [];
      }
    },
    destroy: async () => {
      if (destroyed.value) return;
      destroyed.value = true;
      cache.delete(bookId);
      await safeDestroy(loadingTask);
      disposePdfWorker(workerHandle);
    },
  };
  return handle;
}

async function safeDestroy(task: {
  destroy(): Promise<void>;
}): Promise<void> {
  try {
    await task.destroy();
  } catch {
    /* 已销毁或传输已中断 */
  }
}

/** 读取书签目录，并把目标解析成 0 基页码。 */
async function readOutline(
  doc: PDFDocumentProxy,
  nodes: Awaited<ReturnType<typeof doc.getOutline>>,
): Promise<PdfOutlineItem[]> {
  const items: PdfOutlineItem[] = [];
  for (const node of nodes ?? []) {
    items.push({
      title: typeof node.title === "string" ? node.title : "",
      pageIndex: await resolvePageIndex(doc, node.dest),
      children: await readOutline(doc, node.items ?? []),
    });
  }
  return items;
}

/** 把 pdf.js 的 dest（目标数组 / 命名目标）解析成 0 基页码。 */
async function resolvePageIndex(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  try {
    let target = dest;
    if (typeof target === "string") {
      target = await doc.getDestination(target);
    }
    if (!Array.isArray(target) || target.length === 0) return null;
    const ref = target[0];
    if (!ref) return null;
    const index = await doc.getPageIndex(ref);
    return Number.isInteger(index) && index >= 0 ? index : null;
  } catch {
    return null;
  }
}
