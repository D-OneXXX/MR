import http from "node:http";
import { makePng, makeZip } from "./fixtures.mjs";

/**
 * Deterministic online-source fixture.
 *
 * The acceptance chapter contains 30 real pages plus four site-chrome images
 * (logo / banner / QR / avatar). A separate promo chapter lets QA exercise
 * one-click learning and restore without weakening the clean-chapter assertion.
 */
export async function startOnlineFixture(port = 0) {
  const imageSpecs = new Map();
  const imageCache = new Map();
  const register = (name, width, height, rgb) =>
    imageSpecs.set(name, { width, height, rgb });

  const content = [];
  for (let index = 1; index <= 30; index += 1) {
    const name = `page-${String(index).padStart(3, "0")}.png`;
    const hue = (index * 37) % 255;
    register(name, 800, 1200, [hue, (hue + 70) % 255, (hue + 150) % 255]);
    content.push(name);
  }
  register("spread.png", 1600, 1200, [30, 90, 160]);
  register("extra-wide.png", 2400, 700, [160, 30, 90]);
  register("logo.png", 128, 128, [240, 40, 40]);
  register("icon.png", 64, 64, [250, 200, 30]);
  register("ad.png", 728, 90, [255, 255, 0]);
  register("thumb.png", 240, 240, [20, 20, 20]);
  register("avatar.png", 200, 200, [120, 40, 200]);
  register("qrcode.png", 300, 300, [10, 10, 10]);
  register("extras/credits-final-01.png", 800, 1200, [200, 80, 80]);
  register("extras/credits-final-02.png", 800, 1200, [200, 80, 80]);
  // Strict anti-hotlink fixture: only served when the Referer is the exact
  // manifest URL and the User-Agent is a standard desktop Chrome UA.
  register("protected/1.png", 800, 1200, [210, 60, 60]);
  register("protected/2.png", 800, 1200, [60, 160, 210]);

  const protectedState = {
    expectedReferer: null,
    requests: [],
    manifestRequests: [],
  };

  const resetProtected = () => {
    protectedState.expectedReferer = null;
    protectedState.requests = [];
    protectedState.manifestRequests = [];
  };

  const protectedStats = () => {
    const requests = protectedState.requests.map((entry) => ({ ...entry }));
    const rejected = requests.filter((entry) => !entry.ok);
    const last = requests.at(-1) || null;
    return {
      expectedReferer: protectedState.expectedReferer,
      total: requests.length,
      authorized: requests.length - rejected.length,
      rejected: rejected.length,
      missingReferer: rejected.filter((entry) => entry.reason === "missing-referer")
        .length,
      wrongReferer: rejected.filter((entry) => entry.reason === "wrong-referer")
        .length,
      missingUserAgent: rejected.filter(
        (entry) => entry.reason === "missing-user-agent",
      ).length,
      lastReferer: last?.referer ?? null,
      lastUserAgent: last?.userAgent ?? null,
      lastRejectedReferer: rejected.at(-1)?.referer ?? null,
      lastRejectedUserAgent: rejected.at(-1)?.userAgent ?? null,
      requests,
      manifestRequests: protectedState.manifestRequests.map((entry) => ({
        ...entry,
      })),
    };
  };

  // Telegram/Telegraph fixtures. The embed endpoint intentionally changes the
  // first photo URL after the first request to emulate an expired CDN signature.
  for (let index = 1; index <= 5; index += 1) {
    register(`tg-102-${index}.png`, 800, 1200, [20 + index * 20, 80, 160]);
  }
  register("tg-old-1.png", 800, 1200, [60, 60, 60]);
  register("tg-new-1.png", 800, 1200, [60, 120, 220]);
  for (let index = 2; index <= 3; index += 1) {
    register(`tg-old-${index}.png`, 800, 1200, [70, 70 + index * 10, 90]);
  }
  for (let index = 1; index <= 3; index += 1) {
    register(`tg-telegraph-${index}.png`, 800, 1200, [40, 140, 200 + index]);
  }
  register("tg-logo.png", 96, 96, [220, 30, 30]);

  const documentEntries = [];
  for (let index = 1; index <= 4; index += 1) {
    documentEntries.push([
      `${String(index).padStart(3, "0")}.png`,
      imageBuffer("page-001.png"),
    ]);
  }
  const telegramArchive = makeZip(documentEntries);

  function imageBuffer(name) {
    const cached = imageCache.get(name);
    if (cached) return cached;
    const spec = imageSpecs.get(name);
    if (!spec) return null;
    const bytes = makePng(spec.width, spec.height, spec.rgb);
    imageCache.set(name, bytes);
    return bytes;
  }

  let embed102Requests = 0;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pathname = url.pathname.replace(/^\/+/, "");

    if (url.pathname === "/protected/manifest.json") {
      const manifestUrl = `${origin}${url.pathname}${url.search}`;
      protectedState.expectedReferer = manifestUrl;
      protectedState.manifestRequests.push({
        url: manifestUrl,
        referer: request.headers.referer ?? null,
        userAgent: request.headers["user-agent"] ?? null,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: 1,
          title: "QA Protected Manifest",
          pages: [
            { url: `${origin}/protected/1.png`, width: 800, height: 1200 },
            { url: `${origin}/protected/2.png`, width: 800, height: 1200 },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/protected/1.png" || url.pathname === "/protected/2.png") {
      const referer = request.headers.referer ?? null;
      const userAgent = request.headers["user-agent"] ?? null;
      const expectedReferer = protectedState.expectedReferer;
      const reason = !referer
        ? "missing-referer"
        : referer !== expectedReferer
          ? "wrong-referer"
          : !String(userAgent || "").includes("Mozilla/5.0")
            ? "missing-user-agent"
            : null;
      protectedState.requests.push({
        path: url.pathname,
        referer,
        userAgent,
        expectedReferer,
        ok: reason === null,
        reason,
      });
      if (reason !== null) {
        response.writeHead(403, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        response.end(`forbidden: ${reason}`);
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      response.end(imageBuffer(pathname));
      return;
    }
    if (pathname === "tg-old-1.png") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("expired");
      return;
    }
    if (imageSpecs.has(pathname)) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(imageBuffer(pathname));
      return;
    }

    if (url.pathname === "/manifest-noise.json") {
      const pages = [
        ...content.map((name) => ({
          url: `${origin}/${name}`,
          width: 800,
          height: 1200,
        })),
        { url: `${origin}/logo.png`, width: 128, height: 128 },
        { url: `${origin}/icon.png`, width: 64, height: 64 },
        { url: `${origin}/ad.png`, width: 728, height: 90 },
        { url: `${origin}/thumb.png`, width: 240, height: 240 },
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ version: 1, title: "QA Noise Filter 30", pages }),
      );
      return;
    }
    if (url.pathname === "/manifest-spread.json") {
      const pages = [
        { url: `${origin}/page-001.png`, width: 800, height: 1200 },
        { url: `${origin}/spread.png`, width: 1600, height: 1200 },
        { url: `${origin}/page-002.png`, width: 800, height: 1200 },
        { url: `${origin}/extra-wide.png`, width: 2400, height: 700 },
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: 1, title: "QA Spread", pages }));
      return;
    }
    if (url.pathname === "/manifest-promo-1.json") {
      const pages = [
        { url: `${origin}/page-001.png`, width: 800, height: 1200 },
        { url: `${origin}/page-002.png`, width: 800, height: 1200 },
        { url: `${origin}/page-003.png`, width: 800, height: 1200 },
        { url: `${origin}/extras/credits-final-01.png`, width: 800, height: 1200 },
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: 1, title: "QA Promo 1", pages }));
      return;
    }
    if (url.pathname === "/manifest-promo-2.json") {
      const pages = [
        { url: `${origin}/page-004.png`, width: 800, height: 1200 },
        { url: `${origin}/page-005.png`, width: 800, height: 1200 },
        { url: `${origin}/page-006.png`, width: 800, height: 1200 },
        { url: `${origin}/extras/credits-final-02.png`, width: 800, height: 1200 },
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: 1, title: "QA Promo 2", pages }));
      return;
    }
    if (url.pathname === "/gallery-noise.html") {
      const imgs = content
        .map(
          (name) =>
            `<img src="${origin}/${name}" width="800" height="1200" alt="page">`,
        )
        .join("");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>QA HTML Gallery</title></head>
        <body>
          <header class="site-header"><img src="${origin}/logo.png" width="128" height="128" class="logo"></header>
          <nav><img src="${origin}/ad.png" width="728" height="90" class="ad-banner"></nav>
          <aside class="comments"><img src="${origin}/avatar.png" width="200" height="200" class="avatar"></aside>
          <main><div class="reader-content">
            ${imgs}
            <img src="${origin}/qrcode.png" width="300" height="300" alt="qrcode">
            <img src="${origin}/thumb.png" width="240" height="240" alt="thumbnail">
          </div></main>
          <footer><img src="${origin}/icon.png" width="64" height="64"></footer>
        </body></html>`);
      return;
    }
    if (url.pathname === "/forbidden.json") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"forbidden"}');
      return;
    }
    if (url.pathname === "/invalid.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"version":1,"pages":');
      return;
    }
    if (url.pathname === "/empty.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"version":1,"title":"empty","pages":[]}');
      return;
    }
    if (url.pathname === "/hang.json") {
      return;
    }

    // ---------- Telegram public preview ----------
    if (url.pathname === "/s/testchannel") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head>
        <meta property="og:title" content="QA Telegram Comics">
        </head><body>
        <div class="tgme_channel_info_header_title">QA Telegram Comics</div>
        <div class="tgme_widget_message" data-post="testchannel/101">
          <a class="tgme_widget_message_user_photo"><img src="${origin}/avatar.png"></a>
          <div class="tgme_widget_message_text">频道公告：这里只是闲聊，没有漫画</div>
        </div>
        <div class="tgme_widget_message" data-post="testchannel/102" data-grouped-id="5001">
          <div class="tgme_widget_message_text">第01话 相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-102-1.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-102-2.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-102-3.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="testchannel/103" data-grouped-id="5001">
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-102-4.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-102-5.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="testchannel/104">
          <div class="tgme_widget_message_text">第02话 Telegraph
            <a href="https://telegra.ph/QA-Test-01">https://telegra.ph/QA-Test-01</a>
          </div>
        </div>
        <div class="tgme_widget_message" data-post="testchannel/105">
          <div class="tgme_widget_message_text">第03话 压缩包</div>
          <a class="tgme_widget_message_document_wrap" href="${origin}/files/QA_Telegram_download">QA_Telegram.zip</a>
        </div>
        <div class="tgme_widget_message" data-post="testchannel/106">
          <i class="tgme_widget_message_sticker"></i>
        </div>
        <a class="tme_messages_more" href="?before=99">加载更早</a>
        </body></html>`);
      return;
    }
    if (url.pathname === "/testchannel/102" && url.searchParams.get("embed") === "1") {
      embed102Requests += 1;
      const first =
        embed102Requests <= 1 ? `${origin}/tg-old-1.png` : `${origin}/tg-new-1.png`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <div class="tgme_widget_message" data-post="testchannel/102" data-grouped-id="5001">
          <div class="tgme_widget_message_text">第01话 相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${first}')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-old-2.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('${origin}/tg-old-3.png')"></a>
        </div>
      </body></html>`);
      return;
    }
    if (url.pathname === "/testchannel/104" && url.searchParams.get("embed") === "1") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <div class="tgme_widget_message" data-post="testchannel/104">
          <div class="tgme_widget_message_text">第02话 Telegraph
            <a href="https://telegra.ph/QA-Test-01">https://telegra.ph/QA-Test-01</a>
          </div>
        </div>
      </body></html>`);
      return;
    }
    if (url.pathname === "/telegraph/QA-Test-01") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>QA Telegraph Chapter</title></head>
        <body><article>
          <figure><img src="${origin}/tg-telegraph-1.png"></figure>
          <figure><img src="${origin}/tg-telegraph-2.png"></figure>
          <figure><img src="${origin}/tg-telegraph-3.png"></figure>
          <figure><img src="${origin}/tg-logo.png" width="96" height="96"></figure>
        </article></body></html>`);
      return;
    }
    if (url.pathname === "/files/QA_Telegram_download") {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(telegramArchive.length),
      });
      response.end(telegramArchive);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    origin: `http://127.0.0.1:${actualPort}`,
    protected: {
      manifestPath: "/protected/manifest.json",
      stats: protectedStats,
      reset: resetProtected,
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
