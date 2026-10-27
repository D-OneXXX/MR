/**
 * 合成 PDF 夹具（PDF-2 / PDF-3 / PDF-4）。
 *
 * 全部夹具都在本地生成，不下载任何第三方文档，也不包含真实书库内容：
 * 页面只有纯色块与 Helvetica 文本，字体不内嵌（故意覆盖 PDF.js 的
 * standardFontDataUrl 路径）。
 *
 * 覆盖的安全/健壮性类别（对应 PDF-4 规格）：
 * - valid        普通可读文档
 * - malformed    结构损坏（交叉引用表指向不存在的对象）
 * - truncated    合法文档被截断
 * - badMagic     文件头签名错误
 * - wrongExt     内容合法但扩展名不是 .pdf
 * - encrypted    RC4 40-bit 标准安全处理器加密文档（**单层**加密，见 encryptBytes）
 * - empty        0 字节文件
 * - large        体积明显大于其它夹具（跨多个分块读取）
 * - manyPages    高页数文档
 * - javascript  文档级 + 注释级 JavaScript 动作（应用必须既不执行、也不发请求）
 * - external     指向外部资源的 URI 动作
 * - oddSize      异常页面尺寸（超宽、超高）
 * - brokenImage  内容流里**真正绘制**了一个损坏的图像 XObject。
 *                实测（pdfjs-dist 6.4.299）：PDF.js 记一条 warning 后跳过该图，
 *                页面照常渲染 → 这是**优雅降级**，不是渲染失败。
 * - renderFail   页面对象不是字典而是流、页面内容流是乱码：
 *                PDF.js 取页时抛 "Page dictionary kid reference points to wrong
 *                type of object." → 渲染该页**必然失败**（渲染期失败类别）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** RC4 算法的 32 字节填充口令（PDF 32000-1 节的算法 2）。 */
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...buffers) {
  // PDF 32000-1 的 RC4 标准安全处理器**规定**使用 MD5；这里仅用于生成
  // 「加密 PDF 必须被拒绝」的测试夹具，不处理任何真实口令或用户数据。
  // lgtm[js/insufficient-password-hash]
  // codeql[js/insufficient-password-hash]
  return crypto.createHash("md5").update(Buffer.concat(buffers)).digest();
}

/** 纯 JS RC4：Node 的 OpenSSL 3 默认不提供 rc4 加密原语。 */
function rc4(key, data) {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) state[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    const tmp = state[i];
    state[i] = state[j];
    state[j] = tmp;
  }
  const out = Buffer.alloc(data.length);
  let x = 0;
  let y = 0;
  for (let k = 0; k < data.length; k += 1) {
    x = (x + 1) & 0xff;
    y = (y + state[x]) & 0xff;
    const tmp = state[x];
    state[x] = state[y];
    state[y] = tmp;
    out[k] = data[k] ^ state[(state[x] + state[y]) & 0xff];
  }
  return out;
}

/** 加密对象/流所用的对称密钥（算法 1）。 */
function objectKey(baseKey, objectNumber, generation) {
  const extra = Buffer.alloc(5);
  extra.writeUInt8(objectNumber & 0xff, 0);
  extra.writeUInt8((objectNumber >> 8) & 0xff, 1);
  extra.writeUInt8((objectNumber >> 16) & 0xff, 2);
  extra.writeUInt8(generation & 0xff, 3);
  extra.writeUInt8((generation >> 8) & 0xff, 4);
  const length = Math.min(baseKey.length + 5, 16);
  return md5(baseKey, extra).subarray(0, length);
}

function padPassword(password) {
  const buffer = Buffer.alloc(32);
  buffer.write(password.slice(0, 32), "latin1");
  PAD.copy(buffer, password.length);
  return buffer;
}

function pdfLiteral(text) {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n]/g, " ");
  return `(${escaped})`;
}

function pdfHexFromBuffer(buffer) {
  return `<${buffer.toString("hex")}>`;
}

/**
 * 渲染期失败夹具里的乱码内容流。
 *
 * 必须是**非法的内容流**：不是合法操作符序列（PDF.js 会逐条跳过未知指令），
 * 也不含任何可解析的文本/图形操作。
 */
const GARBLED_CONTENT_STREAM =
  "\x00\x01\x02\x03 not-a-valid-content-stream \xff\xfe\xfd";

/**
 * 渲染期失败夹具里「页面对象」的流字节。
 *
 * 页面对象被写成流（而不是字典），于是 PDF.js 在遍历页树时抛
 * `Page dictionary kid reference points to wrong type of object.`，
 * 取页必然失败 → 这才是真正的「渲染期失败」。
 */
const GARBLED_PAGE_STREAM =
  "garbled-page-object \x00\x01\x02";

/**
 * 文档级 / 注释级 JavaScript 动作体。
 *
 * 两个可观测副作用：
 * - `app.alert('moyu-qa')`：一旦被执行，PDF.js 的脚本管理器会弹对话框；
 * - `globalThis.__moyuQaJsExecuted = true`：一旦被执行，页面全局会出现标记。
 *
 * QA 套件据此断言「文档脚本既没弹框、也没建全局变量」。
 */
const JS_ACTION_BODY =
  "app.alert('moyu-qa'); globalThis.__moyuQaJsExecuted = true;";

/**
 * RC4 40 位（R2/V1）标准安全处理器的加密材料。
 * 只用于生成「加密 PDF」夹具，验证应用按既定策略拒绝带口令的文档。
 */
function buildEncryption(userPassword, ownerPassword, permissionBits) {
  const id = crypto.randomBytes(16);
  const paddedUser = padPassword(userPassword);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(permissionBits, 0);

  // 步骤 1：临时文件密钥（算法 2 的第一轮）。
  const provisional = md5(paddedUser, PAD, permissions, id).subarray(0, 5);
  // 步骤 2：O 值（算法 3，R2 只做一次 RC4）。
  const o = rc4(provisional, paddedUser);
  // 步骤 3：用最终 O 重算文件密钥（算法 2）。
  const fileKey = md5(paddedUser, o, permissions, id).subarray(0, 5);
  // 步骤 4：U 值（算法 4，R2：RC4(PAD, fileKey)）。
  const u = rc4(fileKey, PAD);

  return { id, o, u, permissions, fileKey };
}

/**
 * 生成一个合成 PDF。
 *
 * @param {object} options
 * @param {number} options.pageCount 页数
 * @param {[number,number,number,number]} options.mediaBox 页面尺寸（点）
 * @param {string} options.label 页面文本
 * @param {boolean} options.withJavascript 注入文档级 + 注释级 JavaScript 动作
 * @param {boolean} options.withExternal 注入指向外部资源的动作
 * @param {boolean} options.withBrokenImage 在内容流里绘制一个损坏的图像 XObject
 * @param {boolean} options.withRenderFailPage 第 1 页的对象不是字典而是流（取页必失败）
 * @param {string|null} options.encryption 用户口令（启用标准安全处理器）
 * @param {number} options.fillerBytes 追加的大体积流字节数
 */
export function makePdf(options = {}) {
  const {
    pageCount = 3,
    mediaBox = [0, 0, 595, 842],
    label = "Moyu QA",
    withJavascript = false,
    withExternal = false,
    withBrokenImage = false,
    withRenderFailPage = false,
    encryption = null,
    fillerBytes = 0,
    version = "1.7",
  } = options;

  const encryptor = encryption
    ? buildEncryption(encryption, encryption, -1)
    : null;

  /**
   * 加密只做**一层**（流层）。
   *
   * 真实 PDF 里内容流中的字符串通常还会再单独加密一次（于是流字节与
   * 字符串操作数各一层）。但 PDF.js（6.x）对内容流只解一层：把流字节
   * 解开后，字符串操作数必须已经是明文。旧实现把文本先 RC4 成十六进制、
   * 再把整个内容流 RC4 一次，解出来的文本是乱码（实测
   * `"Ò GÆÑmW¹ -ÕdÂrPI\" 3[‰5}"`），夹具就不再字节忠实。
   * 因此这里保留单层：只有流字节被加密，文本是明文。
   */
  const encryptBytes = (objectNumber, bytes) => {
    if (!encryptor) return bytes;
    const key = objectKey(encryptor.fileKey, objectNumber, 0);
    return rc4(key, bytes);
  };

  // 对象号规划：1=目录 2=页树 3=字体；每页 2 个对象（内容流 + 页面）。
  const fontNumber = 3;
  const pageNumbers = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageNumbers.push({ content: 4 + index * 2, page: 5 + index * 2 });
  }
  let nextNumber = 4 + pageCount * 2;
  const brokenImageNumber = withBrokenImage ? nextNumber++ : 0;
  const fillerNumber = fillerBytes > 0 ? nextNumber++ : 0;
  const encryptNumber = encryptor ? nextNumber++ : 0;

  /** @type {{number:number, body:Buffer|string}[]} */
  const objects = [];
  const pushObject = (number, body) => {
    objects.push({ number, body });
  };

  const width = mediaBox[2] - mediaBox[0];
  const height = mediaBox[3] - mediaBox[1];

  for (let index = 0; index < pageCount; index += 1) {
    const number = pageNumbers[index].content;
    // 渲染期失败夹具：第 1 页的内容流是**乱码**（不是合法内容流）。
    const isRenderFailPage = withRenderFailPage && index === 0;
    const content = isRenderFailPage
      ? GARBLED_CONTENT_STREAM
      : [
          "q",
          "0.85 0.92 1.0 rg",
          `0 0 ${width} ${height} re f`,
          "Q",
          "q",
          "0.1 0.1 0.15 RG",
          "2 w",
          `12 12 ${Math.max(24, width - 24)} ${Math.max(24, height - 24)} re S`,
          "Q",
          // 损坏的图像 XObject 必须**真的被画出来**，渲染器才会碰到它
          // （只挂在 /Resources 上永远不会触发任何解码路径）。
          // cm 需要 6 个参数，写 5 个会被 PDF.js 当成非法指令跳过。
          ...(withBrokenImage
            ? ["q", "100 0 0 100 100 0 cm", "/Im0 Do", "Q"]
            : []),
          "BT",
          "/F1 28 Tf",
          "0.1 0.1 0.15 rg",
          `72 ${Math.max(48, height - 120)} Td`,
          `${pdfLiteral(`${label} page ${index + 1}`)} Tj`,
          "ET",
        ].join("\n");
    const bytes = encryptBytes(number, Buffer.from(content, "latin1"));
    pushObject(
      number,
      Buffer.concat([
        Buffer.from(
          `<< /Length ${bytes.length} >>\nstream\n`,
          "latin1",
        ),
        bytes,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }

  for (let index = 0; index < pageCount; index += 1) {
    const { content, page } = pageNumbers[index];
    const annots = [];
    if (withExternal) {
      annots.push(
        "<< /Type /Annot /Subtype /Link /Rect [10 10 240 44] /Border [0 0 0] /A << /S /URI /URI (https://example.com/moyu-qa) >> >>",
      );
    }
    if (withJavascript) {
      // 注释级 JavaScript：即使应用渲染了注释层，点开链接也绝不能执行脚本。
      annots.push(
        "<< /Type /Annot /Subtype /Link /Rect [10 10 240 44] /Border [0 0 0] /A << /S /JavaScript /JS " +
          pdfLiteral(JS_ACTION_BODY) +
          " >> >>",
      );
    }
    const extras = annots.length ? [`/Annots [${annots.join(" ")}]`] : [];
    if (withRenderFailPage && index === 0) {
      // 渲染期失败夹具：页面对象被写成**流**而不是字典。
      // PDF.js 遍历页树时抛
      // "Page dictionary kid reference points to wrong type of object."，
      // 于是 `doc.getPage(1)` 必然失败 —— 这才是可观测的渲染期失败。
      const bytes = Buffer.from(GARBLED_PAGE_STREAM, "latin1");
      pushObject(
        page,
        Buffer.concat([
          Buffer.from(
            `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(
              " ",
            )}] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${content} 0 R /Length ${bytes.length} >>\nstream\n`,
            "latin1",
          ),
          bytes,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
      continue;
    }
    pushObject(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(
        " ",
      )}] /Resources << /Font << /F1 ${fontNumber} 0 R >>${
        withBrokenImage
          ? ` /XObject << /Im0 ${brokenImageNumber} 0 R >>`
          : ""
      } >> /Contents ${content} 0 R${
        extras.length ? ` ${extras.join(" ")}` : ""
      } >>`,
    );
  }

  pushObject(
    fontNumber,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  pushObject(
    2,
    `<< /Type /Pages /Kids [${pageNumbers
      .map((entry) => `${entry.page} 0 R`)
      .join(" ")}] /Count ${pageCount} >>`,
  );

  const catalogExtras = [];
  if (withJavascript) {
    // 文档级 JavaScript：应用必须既不执行它，也不允许它发起网络请求。
    // 动作体里带一个**全局标记**：一旦被执行，QA 套件能直接在页面里看到
    // `window.__moyuQaJsExecuted === true`（否则「没执行」无法证伪）。
    catalogExtras.push(
      "/OpenAction << /S /JavaScript /JS " +
        pdfLiteral(JS_ACTION_BODY) +
        " >>",
    );
    catalogExtras.push(
      "/Names << /JavaScript << /Names [(qa) << /S /JavaScript /JS " +
        pdfLiteral(JS_ACTION_BODY) +
        " >>] >> >>",
    );
  }
  if (withExternal) {
    catalogExtras.push(
      "/OpenAction << /S /URI /URI (https://example.com/moyu-qa) >>",
    );
  }
  pushObject(
    1,
    `<< /Type /Catalog /Pages 2 0 R${
      catalogExtras.length ? ` ${catalogExtras.join(" ")}` : ""
    } >>`,
  );

  if (withBrokenImage) {
    // 损坏的图像：/Length 与实际数据一致，但数据不是合法的 8x8 灰度位图
    // （声明 64 字节、只给 8 字节）→ 解码必然失败。
    //
    // 实测（pdfjs-dist 6.4.299）：PDF.js 记一条 warning 后**跳过这张图**，
    // 页面照常渲染成功 —— 这是优雅降级，不是渲染失败。
    // 所以「渲染期失败」由另一个夹具（withRenderFailPage）承担。
    const broken = Buffer.from("MISSING!", "latin1");
    pushObject(
      brokenImageNumber,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${broken.length} >>\nstream\n`,
          "latin1",
        ),
        broken,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }

  if (fillerBytes > 0) {
    const filler = crypto.randomBytes(fillerBytes);
    pushObject(
      fillerNumber,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${filler.length} >>\nstream\n`,
          "latin1",
        ),
        filler,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }

  if (encryptor) {
    pushObject(
      encryptNumber,
      `<< /Filter /Standard /V 1 /R 2 /O ${pdfHexFromBuffer(
        encryptor.o,
      )} /U ${pdfHexFromBuffer(encryptor.u)} /P ${encryptor.permissions.readInt32LE(
        0,
      )} >>`,
    );
  }

  objects.sort((a, b) => a.number - b.number);

  const header = Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`, "latin1");
  const chunks = [header];
  const offsets = new Map();
  let cursor = header.length;
  for (const object of objects) {
    offsets.set(object.number, cursor);
    const head = Buffer.from(`${object.number} 0 obj\n`, "latin1");
    const body = Buffer.isBuffer(object.body)
      ? object.body
      : Buffer.from(object.body, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, body, tail);
    cursor += head.length + body.length + tail.length;
  }

  const xrefOffset = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const object of objects) {
    xrefLines.push(
      `${String(offsets.get(object.number)).padStart(10, "0")} 00000 n \n`,
    );
  }
  chunks.push(Buffer.from(xrefLines.join(""), "latin1"));

  const trailerExtras = encryptor
    ? ` /Encrypt ${encryptNumber} 0 R /ID [<${encryptor.id.toString(
        "hex",
      )}> <${encryptor.id.toString("hex")}>]`
    : "";
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      "latin1",
    ),
  );

  return Buffer.concat(chunks);
}

/** 生成一整批 PDF 夹具，返回路径与期望值。 */
export function createPdfFixtures(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const write = (name, bytes) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  const valid = makePdf({ pageCount: 4, label: "Moyu QA Valid" });
  const validFile = write("qa-valid.pdf", valid);

  const manyPagesFile = write(
    "qa-many-pages.pdf",
    makePdf({ pageCount: 120, label: "Moyu QA Many" }),
  );

  const oddWideFile = write(
    "qa-odd-wide.pdf",
    makePdf({
      pageCount: 2,
      mediaBox: [0, 0, 2400, 200],
      label: "Moyu QA Wide",
    }),
  );

  const oddTallFile = write(
    "qa-odd-tall.pdf",
    makePdf({
      pageCount: 2,
      mediaBox: [0, 0, 300, 4200],
      label: "Moyu QA Tall",
    }),
  );

  const javascriptFile = write(
    "qa-javascript.pdf",
    makePdf({ pageCount: 2, withJavascript: true, label: "Moyu QA JS" }),
  );

  const externalFile = write(
    "qa-external.pdf",
    makePdf({ pageCount: 2, withExternal: true, label: "Moyu QA External" }),
  );

  const brokenImageFile = write(
    "qa-broken-image.pdf",
    makePdf({
      pageCount: 2,
      withBrokenImage: true,
      label: "Moyu QA Broken Image",
    }),
  );

  // 渲染期失败夹具：页面对象不是字典、页面内容流是乱码 → 取页必然抛错。
  const renderFailFile = write(
    "qa-render-fail.pdf",
    makePdf({
      pageCount: 2,
      withRenderFailPage: true,
      label: "Moyu QA Render Fail",
    }),
  );

  const encryptedFile = write(
    "qa-encrypted.pdf",
    makePdf({
      pageCount: 2,
      encryption: "moyu-owner",
      label: "Moyu QA Encrypted",
    }),
  );

  const emptyFile = write("qa-empty.pdf", Buffer.alloc(0));

  // 文件头签名错误：保留合法正文，只把 %PDF- 改成 %PDG-。
  const badMagicFile = write(
    "qa-bad-magic.pdf",
    Buffer.concat([
      Buffer.from("%PDG-1.4\n", "latin1"),
      valid.subarray(valid.indexOf("\n", 10) + 1),
    ]),
  );

  const wrongExtFile = write("qa-wrong-extension.txt", valid);

  const truncatedFile = write(
    "qa-truncated.pdf",
    valid.subarray(0, Math.floor(valid.length / 2)),
  );

  // 交叉引用表指向不存在的对象：结构损坏但头部合法。
  const malformedText = valid.toString("latin1");
  const xrefStart = malformedText.lastIndexOf("xref\n");
  const malformed = Buffer.from(malformedText, "latin1");
  if (xrefStart > 0) {
    const firstEntry = malformedText.indexOf(" n \n", xrefStart) + 1;
    if (firstEntry > 0) {
      malformed.write("9999999999", firstEntry, "latin1");
    }
  }
  const malformedFile = write("qa-malformed.pdf", malformed);

  // 体积夹具：合法文档 + 6MB 内嵌流（跨多个分块读取）。
  const largeFile = write(
    "qa-large.pdf",
    makePdf({
      pageCount: 3,
      label: "Moyu QA Large",
      fillerBytes: 6 * 1024 * 1024,
    }),
  );

  return {
    root,
    validFile,
    manyPagesFile,
    oddWideFile,
    oddTallFile,
    javascriptFile,
    externalFile,
    brokenImageFile,
    renderFailFile,
    encryptedFile,
    emptyFile,
    badMagicFile,
    wrongExtFile,
    truncatedFile,
    malformedFile,
    largeFile,
    expected: {
      validPages: 4,
      manyPages: 120,
      encryptedPages: 2,
      largeMinBytes: 6 * 1024 * 1024,
      // 损坏图像夹具：PDF.js 跳过该图、页面照常渲染（优雅降级）。
      brokenImagePages: 2,
      // 渲染期失败夹具：文档能打开，但取页必然抛错。
      renderFailPages: 2,
    },
  };
}
