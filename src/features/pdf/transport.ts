/**
 * PDF 字节区间传输。
 *
 * 后端只提供受控的分块通道（`get_pdf_chunk`：offset + length → base64），
 * 不暴露文件路径，也不做任何网络访问。前端在这里把 pdf.js 的
 * `PDFDataRangeTransport` 协议接到该通道上：
 *
 * - pdf.js 的区间语义与 HTTP Range 一致：`end` **不含**；
 * - 每个区间必须**一次性**交付完整字节（pdf.js 的区间读取器只等一块），
 *   因此单次请求长度受后端 4 MiB 上限约束（见 `PDF_RANGE_CHUNK_SIZE`）。
 */
import type { PdfjsModule } from "./pdfjs";

/** 取字节区间：[begin, end)（end 不含）。 */
export type PdfRangeFetcher = (begin: number, end: number) => Promise<Uint8Array>;

/** pdf.js 的区间传输实例类型。 */
export type PdfDataRangeTransport = InstanceType<
  PdfjsModule["PDFDataRangeTransport"]
>;

/** base64 → 原始字节（后端返回的是无 `data:` 前缀的 base64）。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 构造 pdf.js 的区间传输。
 *
 * `onError` 用于把取字节失败的原因带回上层（上层据此给出稳定错误码），
 * 但协议本身没有错误通道：失败时必须交付**等长**占位字节，否则 pdf.js
 * 会一直等待这个区间，表现为「永远加载中」。
 */
export function createRangeTransport(
  pdfjs: PdfjsModule,
  length: number,
  initialData: Uint8Array | null,
  fetchRange: PdfRangeFetcher,
  onError?: (error: unknown) => void,
): PdfDataRangeTransport {
  const Base = pdfjs.PDFDataRangeTransport;
  class MoyuRangeTransport extends Base {
    constructor() {
      super(length, initialData);
    }

    override requestDataRange(begin: number, end: number): void {
      const size = Math.max(0, end - begin);
      if (size === 0) {
        this.onDataRange(begin, null);
        return;
      }
      void fetchRange(begin, end).then(
        (chunk) => {
          this.onDataRange(begin, chunk);
        },
        (error: unknown) => {
          onError?.(error);
          // 等长零填充：区间必须完整交付，否则 pdf.js 会悬挂等待。
          this.onDataRange(begin, new Uint8Array(size));
        },
      );
    }
  }
  return new MoyuRangeTransport();
}
