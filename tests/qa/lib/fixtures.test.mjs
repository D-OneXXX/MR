/**
 * 夹具自检：超高条漫必须用**渐变**图，否则「多片内容不同」的断言无效。
 *
 * 背景见 Issue #32：纯色 800×21000 图切出的每一片像素完全相同 →
 * 编码字节相同 → data URL 相同 → 「加载到 2 张不同切片」实际退化成
 * 「渲染宽度是否变化」的无效断言（hosted 恒失败、本地偶然通过）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { makePng, makeRampPng } from "./fixtures.mjs";

/** 解析本模块生成的 PNG（filter 0、RGB8），返回逐行像素数据。 */
function decodeRows(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "位深必须是 8");
  assert.equal(png[25], 2, "颜色类型必须是 RGB");

  const idat = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowLength = 1 + width * 3;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * rowLength, (y + 1) * rowLength);
    assert.equal(row[0], 0, "本模块只生成 filter 0");
    rows.push(row.subarray(1));
  }
  return { width, height, rows };
}

test("makeRampPng：不同行的像素必然不同（切片内容可区分）", () => {
  const { width, height, rows } = decodeRows(
    makeRampPng(8, 16, [128, 64], 1),
  );
  assert.equal(width, 8);
  assert.equal(height, 16);
  const first = rows[0].subarray(0, 3).toString("hex");
  const middle = rows[8].subarray(0, 3).toString("hex");
  const last = rows[15].subarray(0, 3).toString("hex");
  assert.notEqual(first, middle, "上半与中段必须不同");
  assert.notEqual(middle, last, "中段与末段必须不同");
  // 红通道必须单调上升（与 Rust `ultra_tall_page` 的 ramp 同公式）。
  const red = (row) => row[0];
  assert.ok(red(rows[8]) > red(rows[0]));
  assert.ok(red(rows[15]) > red(rows[8]));
});

test("makePng：纯色图各行完全相同（说明为何不能用作切片夹具）", () => {
  const { rows } = decodeRows(makePng(8, 16, [36, 120, 210], 1));
  const first = rows[0].toString("hex");
  for (const row of rows) {
    assert.equal(row.toString("hex"), first, "纯色图的所有行必须完全一致");
  }
});

test("makeRampPng：同一行内像素一致（保证压缩体积可控）", () => {
  const { width, rows } = decodeRows(makeRampPng(8, 4, [128, 64], 1));
  const row = rows[1];
  for (let x = 0; x < width; x += 1) {
    assert.equal(
      row.subarray(x * 3, x * 3 + 3).toString("hex"),
      row.subarray(0, 3).toString("hex"),
    );
  }
});
