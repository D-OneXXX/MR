/**
 * PDF 夹具自检：保证合成夹具既能覆盖安全类别，又确实可被 PDF.js 解析。
 *
 * 三层断言：
 * 1) 纯字节层——不依赖任何解析器，校验签名、加密字典、xref 破坏与体积；
 * 2) 行为层——用随包发布的 PDF.js 真正加载夹具，校验页数与错误类别
 *    （PasswordException / InvalidPDFException），避免「夹具写坏导致安全用例
 *    测的不是想测的东西」；
 * 3) 契约层——把每个「安全类别」的**预期结局**钉死，避免夹具悄悄退化成
 *    「其实什么也没测」：
 *    - 损坏图像：PDF.js 跳过该图、页面照常渲染（优雅降级，**不是**渲染失败）；
 *    - 渲染期失败：文档能打开，但取页必然抛错；
 *    - 加密夹具：只有一层加密，带口令时文本能正确解密；
 *    - 脚本沙箱：随包发布的 pdf.js 产物里没有 quickjs-eval。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPdfFixtures, makePdf } from "./pdf-fixtures.mjs";

function tempRoot(label) {
  const nanos = Date.now();
  return path.join(
    os.tmpdir(),
    `moyu-pdf-fixture-${label}-${process.pid}-${nanos}`,
  );
}

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  } catch (error) {
    pdfjs = null;
    void error;
  }
  return pdfjs;
}

/**
 * 与 `src/features/pdf/transport.ts` 等价的区间传输。
 *
 * 应用读 PDF 走的是「后端字节区间 + pdf.js range 传输」这条路，
 * 因此关键夹具必须在这条路上复现同样的结局（只测 `data` 模式不够）。
 */
function rangeTransport(lib, bytes) {
  const Base = lib.PDFDataRangeTransport;
  class MoyuRangeTransport extends Base {
    constructor() {
      super(bytes.length, null);
    }
    requestDataRange(begin, end) {
      const size = Math.max(0, end - begin);
      if (size === 0) {
        this.onDataRange(begin, null);
        return;
      }
      this.onDataRange(begin, new Uint8Array(bytes.subarray(begin, end)));
    }
  }
  return new MoyuRangeTransport();
}

/** 最小 2D 上下文桩：Node 里没有 canvas，但 pdf.js 只需要它「不抛异常」。 */
function stubCanvas(width, height) {
  const matrix = () => {
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    m.invertSelf = () => m;
    m.clone = () => matrix();
    m.multiply = () => m;
    m.scaleSelf = () => m;
    m.translateSelf = () => m;
    return m;
  };
  const providers = {
    getTransform: () => matrix(),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    createImageData: (w, h) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    measureText: () => ({ width: 0 }),
    getLineDash: () => [],
  };
  const canvas = { width, height, getContext: null };
  const context = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "canvas") return canvas;
        if (prop in providers) return providers[prop];
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  );
  canvas.getContext = () => context;
  return { canvas, context };
}

/** 渲染第 1 页；返回 true 表示渲染成功。 */
async function renderFirstPage(doc) {
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const { canvas, context } = stubCanvas(
    Math.ceil(viewport.width) || 1,
    Math.ceil(viewport.height) || 1,
  );
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  return true;
}

test("makePdf：输出合法 PDF 头与交叉引用表", () => {
  const bytes = makePdf({ pageCount: 3 });
  const text = bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.7\n"), "必须以 %PDF- 开头");
  assert.ok(text.includes("%%EOF\n"), "必须以 %%EOF 结束");
  assert.ok(text.includes("/Type /Catalog"), "必须有文档目录");
  assert.ok(text.includes("/Type /Pages"), "必须有页树");
  assert.ok(text.includes("/Type /Page "), "必须有页面对象");
  const startxrefMatches = [...text.matchAll(/startxref\s+(\d+)/g)];
  assert.ok(startxrefMatches.length > 0, "必须含 startxref");
  const startxref = Number(startxrefMatches[startxrefMatches.length - 1][1]);
  assert.ok(startxref > 0 && startxref < bytes.length, "startxref 必须指向文件内");
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref 必须指向 xref");
});

test("makePdf：页数与页面对象数量一致", () => {
  for (const pageCount of [1, 4, 120]) {
    const text = makePdf({ pageCount }).toString("latin1");
    const pageObjects = text.match(/\/Type \/Page \/Parent/g) ?? [];
    assert.equal(pageObjects.length, pageCount);
    assert.ok(text.includes(`/Count ${pageCount} `), "页树 Count 必须匹配");
  }
});

test("makePdf：加密夹具带标准安全处理器字典", () => {
  const text = makePdf({ pageCount: 2, encryption: "moyu-owner" }).toString(
    "latin1",
  );
  assert.ok(text.includes("/Filter /Standard"), "必须有标准安全处理器");
  assert.ok(text.includes("/V 1"), "必须是 40 位 V1");
  assert.ok(text.includes("/R 2"), "必须是 R2");
  assert.ok(text.includes("/Encrypt "), "trailer 必须引用加密字典");
  assert.ok(text.includes("/ID [<"), "加密文档必须有 /ID");
});

test("makePdf：JavaScript / 外部资源夹具确实带对应动作", () => {
  const js = makePdf({ pageCount: 1, withJavascript: true }).toString("latin1");
  assert.ok(js.includes("/S /JavaScript"), "必须含 JavaScript 动作");
  assert.ok(js.includes("/Names << /JavaScript"), "必须含 JavaScript 名称树");
  // 脚本体必须带可观测副作用，否则「脚本没被执行」根本无法证伪。
  assert.ok(
    js.includes("__moyuQaJsExecuted"),
    "JavaScript 动作必须写全局标记，才能观测「是否被执行」",
  );
  assert.ok(
    /\/Annots \[\s*<<[^>]*\/S \/JavaScript/.test(js),
    "必须含注释级 JavaScript 动作",
  );

  const external = makePdf({ pageCount: 1, withExternal: true }).toString(
    "latin1",
  );
  assert.ok(external.includes("/S /URI"), "必须含 URI 动作");
  assert.ok(external.includes("example.com/moyu-qa"), "必须含外部地址");
});

test("makePdf：损坏图像被真正画进内容流（否则渲染器根本碰不到它）", () => {
  const text = makePdf({ pageCount: 1, withBrokenImage: true }).toString(
    "latin1",
  );
  assert.ok(text.includes("/Im0 Do"), "内容流必须真正绘制损坏的 XObject");
  // cm 需要 6 个参数：写 5 个会被 PDF.js 当成非法指令整条跳过。
  assert.ok(
    /100 0 0 100 100 0 cm\s*\/Im0 Do/.test(text),
    "绘制损坏图像前必须是合法的 6 参数 cm",
  );
  assert.ok(text.includes("/XObject << /Im0"), "资源里必须挂上损坏的 XObject");
});

test("makePdf：渲染期失败夹具把页面对象写成流、内容流写成乱码", () => {
  const text = makePdf({ pageCount: 2, withRenderFailPage: true }).toString(
    "latin1",
  );
  assert.ok(
    text.includes("garbled-page-object"),
    "页面对象必须带乱码流字节",
  );
  assert.ok(
    text.includes("not-a-valid-content-stream"),
    "第 1 页内容流必须是乱码",
  );
  // 页面对象是流（而不是字典）：这是取页失败的根因。
  assert.ok(
    /<< \/Type \/Page[^\n]*\/Length \d+ >>\nstream\n/.test(text),
    "页面对象必须是流（带 /Length 的 stream）",
  );
});

test("makePdf：异常页面尺寸写入 MediaBox", () => {
  const wide = makePdf({ mediaBox: [0, 0, 2400, 200] }).toString("latin1");
  assert.ok(wide.includes("/MediaBox [0 0 2400 200]"), "超宽页面尺寸必须保留");
  const tall = makePdf({ mediaBox: [0, 0, 300, 4200] }).toString("latin1");
  assert.ok(tall.includes("/MediaBox [0 0 300 4200]"), "超高页面尺寸必须保留");
});

test("createPdfFixtures：产出全部安全类别夹具", () => {
  const root = tempRoot("shape");
  try {
    const fixtures = createPdfFixtures(root);
    assert.ok(fs.existsSync(fixtures.validFile));
    assert.ok(fs.existsSync(fixtures.encryptedFile));
    assert.ok(fs.existsSync(fixtures.emptyFile));
    assert.ok(fs.existsSync(fixtures.badMagicFile));
    assert.ok(fs.existsSync(fixtures.wrongExtFile));
    assert.ok(fs.existsSync(fixtures.truncatedFile));
    assert.ok(fs.existsSync(fixtures.malformedFile));
    assert.ok(fs.existsSync(fixtures.javascriptFile));
    assert.ok(fs.existsSync(fixtures.externalFile));
    assert.ok(fs.existsSync(fixtures.brokenImageFile));
    assert.ok(fs.existsSync(fixtures.renderFailFile));
    assert.ok(fs.existsSync(fixtures.oddWideFile));
    assert.ok(fs.existsSync(fixtures.oddTallFile));

    assert.equal(fs.statSync(fixtures.emptyFile).size, 0, "空夹具必须是 0 字节");
    assert.ok(
      fs.readFileSync(fixtures.badMagicFile).subarray(0, 5).toString("latin1") ===
        "%PDG-",
      "签名错误夹具必须不是 %PDF-",
    );
    assert.ok(
      fs.readFileSync(fixtures.wrongExtFile).subarray(0, 5).toString("latin1") ===
        "%PDF-",
      "扩展名错误夹具的内容必须是合法 PDF",
    );
    assert.ok(
      fs.statSync(fixtures.largeFile).size > fixtures.expected.largeMinBytes,
      "大体积夹具必须超过 6MB",
    );
    assert.ok(
      fs.statSync(fixtures.truncatedFile).size <
        fs.statSync(fixtures.validFile).size,
      "截断夹具必须短于完整文档",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createPdfFixtures：PDF.js 行为符合预期（页数与错误类别）", async (t) => {
  const lib = await loadPdfjs();
  if (!lib) {
    t.skip("pdfjs-dist 不可用，跳过行为层断言");
    return;
  }
  const root = tempRoot("behaviour");
  try {
    const fixtures = createPdfFixtures(root);
    const load = async (file) => {
      const bytes = new Uint8Array(fs.readFileSync(file));
      const task = lib.getDocument({
        data: bytes,
        useSystemFonts: false,
        cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
        standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
      });
      return task.promise;
    };

    const valid = await load(fixtures.validFile);
    assert.equal(valid.numPages, fixtures.expected.validPages);
    await valid.cleanup();

    const many = await load(fixtures.manyPagesFile);
    assert.equal(many.numPages, fixtures.expected.manyPages);
    await many.cleanup();

    // 加密文档：必须抛 PasswordException（应用按既定策略拒绝口令文档）。
    await assert.rejects(
      () => load(fixtures.encryptedFile),
      (error) => error?.name === "PasswordException",
      "加密夹具必须触发 PasswordException",
    );

    // 空文档：必须抛 InvalidPDFException。
    await assert.rejects(
      () => load(fixtures.emptyFile),
      (error) => error?.name === "InvalidPDFException",
      "空夹具必须触发 InvalidPDFException",
    );

    // 截断文档：必须抛 InvalidPDFException。
    await assert.rejects(
      () => load(fixtures.truncatedFile),
      (error) => error?.name === "InvalidPDFException",
      "截断夹具必须触发 InvalidPDFException",
    );

    // 含 JavaScript 的文档可以打开，但应用不得执行脚本；这里只确认结构可解析。
    const scripted = await load(fixtures.javascriptFile);
    assert.ok(scripted.numPages >= 1);
    assert.equal(await scripted.hasJSActions(), true, "必须能识别出文档级 JS 动作");
    await scripted.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("契约：损坏图像夹具是「优雅降级」，不是渲染失败", async (t) => {
  const lib = await loadPdfjs();
  if (!lib) {
    t.skip("pdfjs-dist 不可用，跳过行为层断言");
    return;
  }
  const root = tempRoot("broken-image");
  try {
    const fixtures = createPdfFixtures(root);
    // pdf.js 会「接管」传入的 ArrayBuffer（transfer），因此每次加载都必须给一份新副本。
    const fresh = () => new Uint8Array(fs.readFileSync(fixtures.brokenImageFile));
    for (const mode of ["data", "range"]) {
      const bytes = fresh();
      const doc = await lib.getDocument(
        mode === "data"
          ? {
              data: bytes,
              useSystemFonts: false,
              cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
              standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
            }
          : {
              range: rangeTransport(lib, bytes),
              rangeChunkSize: 1048576,
              disableAutoFetch: false,
              useSystemFonts: false,
              cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
              standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
            },
      ).promise;
      // 实测结论：PDF.js 跳过损坏的图像，页面照常渲染。
      assert.equal(
        await renderFirstPage(doc),
        true,
        `损坏图像夹具在 ${mode} 模式下必须渲染成功（优雅降级）`,
      );
      await doc.cleanup();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("契约：渲染期失败夹具 —— 文档能打开，但取页必然抛错", async (t) => {
  const lib = await loadPdfjs();
  if (!lib) {
    t.skip("pdfjs-dist 不可用，跳过行为层断言");
    return;
  }
  const root = tempRoot("render-fail");
  try {
    const fixtures = createPdfFixtures(root);
    // pdf.js 会「接管」传入的 ArrayBuffer（transfer），因此每次加载都必须给一份新副本。
    const fresh = () => new Uint8Array(fs.readFileSync(fixtures.renderFailFile));
    for (const mode of ["data", "range"]) {
      const bytes = fresh();
      const doc = await lib.getDocument(
        mode === "data"
          ? {
              data: bytes,
              useSystemFonts: false,
              cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
              standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
            }
          : {
              range: rangeTransport(lib, bytes),
              rangeChunkSize: 1048576,
              disableAutoFetch: false,
              useSystemFonts: false,
              cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
              standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
            },
      ).promise;
      // 文档本身可解析（不是导入期/打开期失败）。
      assert.ok(doc.numPages >= 1, `渲染失败夹具在 ${mode} 模式下必须能打开`);
      // 取页（= 应用渲染管线里的第一步）必须失败。
      await assert.rejects(
        () => doc.getPage(1),
        (error) => Boolean(error && error.message),
        `渲染失败夹具在 ${mode} 模式下取页必须抛错`,
      );
      await doc.cleanup().catch(() => {});
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("契约：加密夹具只有一层加密，带口令时文本能正确解密", async (t) => {
  const lib = await loadPdfjs();
  if (!lib) {
    t.skip("pdfjs-dist 不可用，跳过行为层断言");
    return;
  }
  const root = tempRoot("encrypted-text");
  try {
    const fixtures = createPdfFixtures(root);
    const bytes = new Uint8Array(fs.readFileSync(fixtures.encryptedFile));
    const doc = await lib.getDocument({
      data: bytes,
      password: "moyu-owner",
      useSystemFonts: false,
      cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
      standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
    }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join("");
    // 双层加密（流层 + 字符串层）会让 PDF.js 解出来的文本变成乱码；
    // 单层加密才能得到原文 —— 夹具必须字节忠实。
    assert.equal(
      text,
      "Moyu QA Encrypted page 1",
      "加密夹具解开后必须是可读原文",
    );
    await doc.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("契约：随包发布的 pdf.js 不含脚本沙箱（quickjs-eval 未被打包）", () => {
  const artifacts = [
    "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    "../../../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs",
  ];
  for (const relative of artifacts) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.ok(
      !/quickjs/i.test(source),
      `${path.basename(file)} 不得包含 quickjs 脚本沙箱`,
    );
  }
});
