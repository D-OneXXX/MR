#!/usr/bin/env node
/**
 * W6 真机验证用的**临时**静态投递器（手动工具，CI 永不调用）。
 *
 * 用途：把 `dist/` 里的 Web 入口投递到局域网，让手机打开一个 URL 完成
 * W6 的能力自采集（`/web.html?probe=1`）。
 *
 * ⚠️ 这**不是**产品的一部分：Moyu 自身不监听任何端口，本脚本只在校验窗口内
 * 由人显式启动与停止。它只做静态文件分发——**不含任何 API、不读写书库**。
 *
 * 用法：
 *   # 明文 HTTP（用来验证"非安全上下文"这一支）
 *   node tests/qa/tools/serve-web-for-device.mjs --port 8788
 *
 *   # HTTPS（用来验证"自签证书 + 手工信任"这一支）
 *   # 证书用 PowerShell 生成（需要管理员）：
 *   #   New-SelfSignedCertificate -DnsName "moyu.local" -CertStoreLocation Cert:\CurrentUser\My
 *   #   Export-PfxCertificate -Cert cert:\CurrentUser\My\<thumbprint> -FilePath moyu.pfx -Password (ConvertTo-SecureString "pass" -AsPlainText -Force)
 *   node tests/qa/tools/serve-web-for-device.mjs --port 8443 --pfx moyu.pfx --pfx-pass pass
 *
 * 选项：
 *   --port       监听端口（默认 8788）
 *   --host       监听地址（默认 0.0.0.0，即局域网可达；只测本机可传 127.0.0.1）
 *   --dir        静态目录（默认 dist）
 *   --pfx        HTTPS 证书（PFX 文件路径）
 *   --pfx-pass   PFX 口令
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", "8788"));
const host = arg("host", "0.0.0.0");
const dir = path.resolve(arg("dir", "dist"));
const pfxPath = arg("pfx", null);
const pfxPass = arg("pfx-pass", null);

if (!fs.existsSync(dir)) {
  console.error(`[serve] 静态目录不存在：${dir}（先跑 npm run build）`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = pfxPath
  ? https.createServer(
      {
        pfx: fs.readFileSync(pfxPath),
        passphrase: pfxPass || undefined,
      },
      handler,
    )
  : http.createServer(handler);

function handler(req, res) {
  const url = new URL(req.url, "http://placeholder");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(dir, rel);
  // 目录穿越防护：解析后的路径必须仍在静态目录内。
  if (!file.startsWith(dir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      // 验证窗口内一律不缓存，避免测到旧产物。
      "cache-control": "no-store",
    });
    res.end(data);
  });
  console.log(`[serve] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
}

server.listen(port, host, () => {
  const scheme = pfxPath ? "https" : "http";
  const addrs = lanAddresses();
  console.log(`[serve] 静态目录：${dir}`);
  console.log(`[serve] 协议：${scheme}${pfxPath ? "（自签证书，手机需先信任）" : "（明文）"}`);
  for (const a of addrs) {
    console.log(`[serve]   → ${scheme}://${a}:${port}/web.html?probe=1`);
  }
  if (addrs.length === 0) console.log("[serve]   （未发现局域网地址）");
  console.log("[serve] 手机与本机需在同一网络；Ctrl+C 停止。");
});

process.on("SIGINT", () => {
  console.log("\n[serve] 已停止。");
  server.close(() => process.exit(0));
});
