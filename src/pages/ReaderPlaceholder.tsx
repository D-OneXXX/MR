import Reader from "./Reader";

/**
 * 占位页已由真阅读器替换（阶段二）：保留文件与路由名，
 * 直接渲染暗色沉浸阅读器。
 */
export default function ReaderPlaceholder() {
  return <Reader />;
}
