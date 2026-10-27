/**
 * PDF 阅读能力入口（PDF-2）。
 *
 * 渲染在 WebView 内完成（pdf.js），字节通过后端分块通道读取，
 * 全程本地、离线、无遥测。
 */
export * from "./pdfjs";
export * from "./transport";
export * from "./document";
export * from "./render";
export * from "./cover";
export * from "./errors";
