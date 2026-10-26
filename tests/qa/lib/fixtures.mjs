import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/** Minimal opaque RGB PNG (no external image libraries). */
export function makePng(width, height, [red, green, blue], deflateLevel = 9) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: deflateLevel })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 竖向渐变 PNG：红通道色阶随 y 线性变化（与 Rust `ultra_tall_page` 的 ramp
 * 同公式：`r = floor(y * 255 / h)`，绿/蓝固定）。
 *
 * 为什么超高条漫夹具必须用渐变而不是纯色：
 * 纯色图被切成多片后，**每一片的像素完全相同** → 编码字节相同 → data URL 相同。
 * 此时「加载到 2 张不同的切片图片」这个断言实际上在测量「渲染宽度有没有变」，
 * 而不是「巨图有没有被切片」，属于无效断言（hosted 与本地结果不一致的根因）。
 * 渐变夹具让不同切片的内容必然不同，切片断言才真正有效。
 */
export function makeRampPng(
  width,
  height,
  [green, blue],
  deflateLevel = 1,
) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowLength = 1 + width * 3;
  const row = Buffer.alloc(rowLength);
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const step = Math.floor((y * 255) / height);
    row[0] = 0;
    row[1] = step;
    row[2] = green;
    row[3] = blue;
    for (let x = 1; x < rowLength; x += 3) {
      row[x] = step;
      row[x + 1] = green;
      row[x + 2] = blue;
    }
    row.copy(raw, y * rowLength);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: deflateLevel })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

/** Deterministic ZIP (stored entries, UTF-8 names) for archive-format tests. */
export function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(bytes);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(bytes.length),
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      bytes,
    ]);
    localParts.push(local);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(bytes.length),
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

function writeBookFolder(root, name, count, width, height) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const hue = (index * 47) % 255;
    const png = makePng(width, height, [hue, (hue * 2 + 60) % 255, (hue * 5 + 120) % 255]);
    fs.writeFileSync(path.join(dir, `${String(index + 1).padStart(3, "0")}.png`), png);
  }
  return dir;
}

function archiveEntries(count, width, height) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const hue = (index * 31 + 80) % 255;
    entries.push([
      `${String(index + 1).padStart(3, "0")}.png`,
      makePng(width, height, [hue, (hue + 90) % 255, (hue + 180) % 255]),
    ]);
  }
  return entries;
}

function writeNaturalFolder(root) {
  const dir = path.join(root, "QA Natural Order");
  fs.mkdirSync(dir, { recursive: true });
  // Deliberately unpadded: lexicographic sorting would yield 1, 10, 11, 2.
  for (const [index, name] of ["1.png", "2.png", "10.png", "11.png"].entries()) {
    const hue = (index * 61 + 20) % 255;
    fs.writeFileSync(
      path.join(dir, name),
      makePng(480, 720, [hue, (hue + 80) % 255, (hue + 160) % 255]),
    );
  }
  return dir;
}

function writeNaturalLabelsFolder(root) {
  const dir = path.join(root, "QA Natural Chapters");
  fs.mkdirSync(dir, { recursive: true });
  // Written in lexicographic order (第10/第11 before 第1/第2); natural sorting
  // must yield 1, 2, 10, 11 rather than the on-disk/zip order.
  for (const [index, name] of ["第10话.png", "第1话.png", "第11话.png", "第2话.png"].entries()) {
    const hue = (index * 47 + 130) % 255;
    fs.writeFileSync(
      path.join(dir, name),
      makePng(360, 540, [hue, (hue + 60) % 255, (hue + 120) % 255]),
    );
  }
  return dir;
}

/** 20-page CBZ written in lexicographic order (1,10,11,...,19,2,20,3...). */
function writeNaturalArchive(root) {
  const names = Array.from({ length: 20 }, (_, index) => `${index + 1}.png`);
  const widths = Object.fromEntries(
    names.map((name) => [Number(name.replace(".png", "")), 400 + Number(name.replace(".png", "")) * 8]),
  );
  const entries = [...names].sort().map((name) => {
    const page = Number(name.replace(".png", ""));
    const hue = (page * 13) % 255;
    return [
      name,
      makePng(widths[page], 800, [hue, (hue + 70) % 255, (hue + 140) % 255]),
    ];
  });
  const archive = path.join(root, "QA_Natural_20.cbz");
  fs.writeFileSync(archive, makeZip(entries));
  return { archive, widths };
}

/**
 * 超高条漫夹具：单页 800×21000（>8192 纹理安全线，且远超 WebView2 纹理上限）。
 *
 * 目的：
 * - 条漫「先切后缩」必须把巨图切成多片渲染，前端不得出现黑/白块；
 * - 单页模式渲染高度必须被钳制到 ≤ MAX_SAFE_TEXTURE_H(8192)。
 *
 * 必须用**竖向渐变**而不是纯色：纯色图切出的每一片像素完全相同，
 * 「多张不同切片」的断言会退化成「渲染宽度是否变化」的无效断言
 * （见 `makeRampPng` 注释与 Issue #32）。
 *
 * 体积控制：渐变 PNG 压缩后约几百 KB；生成期 raw 缓冲为
 * 800×21000×3 ≈ 48MB，用 deflate level 1 把生成耗时压到秒级。
 */
function writeUltraTallWebtoon(root, width, height) {
  const dir = path.join(root, "QA Ultra Tall Webtoon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "001.png"),
    makeRampPng(width, height, [128, 64], 1),
  );
  return dir;
}

export function createQaFixtures(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const folder = writeBookFolder(root, "QA Local Folder", 10, 640, 960);
  const longWebtoon = writeBookFolder(root, "QA Long Webtoon", 125, 360, 1080);
  const naturalOrder = writeNaturalFolder(root);
  const naturalLabels = writeNaturalLabelsFolder(root);
  const naturalArchive = writeNaturalArchive(root);

  const cjkDir = path.join(root, "中文目录 含空格");
  fs.mkdirSync(cjkDir, { recursive: true });
  const cjkArchive = path.join(cjkDir, "QA_CJK_Path.cbz");
  fs.writeFileSync(cjkArchive, makeZip(archiveEntries(6, 720, 1080)));

  const zipPath = path.join(root, "QA_Archive.zip");
  fs.writeFileSync(zipPath, makeZip(archiveEntries(4, 640, 960)));

  const broken = path.join(root, "QA_Broken.cbz");
  fs.writeFileSync(broken, crypto.randomBytes(2048));

  // 超高条漫（单页 800×21000）：AGENTS.md §4.2 的巨图防线夹具。
  const ultraTallWidth = 800;
  const ultraTallHeight = 21000;
  const ultraTall = writeUltraTallWebtoon(root, ultraTallWidth, ultraTallHeight);

  return {
    root,
    folder,
    longWebtoon,
    naturalOrder,
    naturalLabels,
    naturalArchive: naturalArchive.archive,
    cjkArchive,
    zipPath,
    broken,
    ultraTall,
    importOrder: [
      folder,
      naturalOrder,
      naturalLabels,
      naturalArchive.archive,
      cjkArchive,
      zipPath,
      longWebtoon,
      broken,
      ultraTall,
    ],
    expected: {
      folderPages: 10,
      cjkPages: 6,
      zipPages: 4,
      webtoonPages: 125,
      naturalPages: 4,
      ultraTallPages: 1,
      ultraTallWidth,
      ultraTallHeight,
      naturalOrder: ["1.png", "2.png", "10.png", "11.png"],
      naturalArchiveOrder: Array.from({ length: 20 }, (_, index) => `${index + 1}.png`),
      naturalArchiveWidths: naturalArchive.widths,
      naturalLabelsOrder: ["第1话.png", "第2话.png", "第10话.png", "第11话.png"],
    },
  };
}

export function markerFile(root, name) {
  const file = path.join(root, name);
  fs.writeFileSync(file, "fixture\n");
  return file;
}
