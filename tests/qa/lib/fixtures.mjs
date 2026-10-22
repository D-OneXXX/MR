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
export function makePng(width, height, [red, green, blue]) {
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
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
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

export function createQaFixtures(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const folder = writeBookFolder(root, "QA Local Folder", 10, 640, 960);
  const longWebtoon = writeBookFolder(root, "QA Long Webtoon", 125, 360, 1080);
  const naturalOrder = writeNaturalFolder(root);

  const cjkDir = path.join(root, "中文目录 含空格");
  fs.mkdirSync(cjkDir, { recursive: true });
  const cjkArchive = path.join(cjkDir, "QA_CJK_Path.cbz");
  fs.writeFileSync(cjkArchive, makeZip(archiveEntries(6, 720, 1080)));

  const zipPath = path.join(root, "QA_Archive.zip");
  fs.writeFileSync(zipPath, makeZip(archiveEntries(4, 640, 960)));

  const broken = path.join(root, "QA_Broken.cbz");
  fs.writeFileSync(broken, crypto.randomBytes(2048));

  return {
    root,
    folder,
    longWebtoon,
    naturalOrder,
    cjkArchive,
    zipPath,
    broken,
    importOrder: [folder, naturalOrder, cjkArchive, zipPath, longWebtoon, broken],
    expected: {
      folderPages: 10,
      cjkPages: 6,
      zipPages: 4,
      webtoonPages: 125,
      naturalPages: 4,
      naturalOrder: ["1.png", "2.png", "10.png", "11.png"],
    },
  };
}

export function markerFile(root, name) {
  const file = path.join(root, name);
  fs.writeFileSync(file, "fixture\n");
  return file;
}
