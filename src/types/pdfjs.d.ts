/**
 * pdfjs-dist 子路径类型声明。
 *
 * pdfjs-dist 的 package.json 只给根路径配了 "types"，legacy 构建
 * （`legacy/build/pdf.min.mjs`）没有自带声明文件。这里把子路径的导出
 * 对齐到根类型，业务代码里就不需要 any。
 */
declare module "pdfjs-dist/legacy/build/pdf.min.mjs" {
  export * from "pdfjs-dist";
}
