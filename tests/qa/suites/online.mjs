import { enableOnline, invoke, invokeSafe } from "../lib/app.mjs";
import { fail, ok } from "../lib/report.mjs";

function pageCount(result) {
  return result?.page_count ?? result?.pageCount ?? 0;
}

async function resolveOk(page, url, report, id, title) {
  const book = await invoke(page, "resolve_online_url", { url });
  ok(report, {
    id,
    suite: "online",
    layer: "integration",
    title,
    details: `${book.title} · ${pageCount(book)} 页`,
  });
  return book;
}

export async function runOnlineSuite(ctx, report) {
  const page = ctx.page;
  const fixture = ctx.onlineFixture;
  if (!fixture) {
    fail(report, {
      id: "online:fixture-missing",
      suite: "online",
      layer: "infrastructure",
      title: "在线夹具未启动",
      severity: "P0",
      location: "tests/qa/run-qa.mjs",
    });
    return;
  }
  await enableOnline(page);

  const probe = await invoke(page, "test_online_connection", {
    url: `${fixture.origin}/manifest-noise.json`,
  });
  if (!probe.ok || probe.pageCount !== 30) {
    fail(report, {
      id: "online:noise-json",
      suite: "online",
      layer: "integration",
      title: "JSON 清单未从 30 页正文中剔除噪音图",
      severity: "P1",
      details: JSON.stringify(probe),
      location: "src-tauri/src/online/filter.rs / direct.rs",
      expected: "保留 30 张正文，剔除 logo/icon/banner/thumbnail",
      actual: `${probe.pageCount} 页 · ${probe.message}`,
      rootCause: "过滤漏斗未生效或阈值错误",
      fix: "检查尺寸/负面词/主序列聚类与站点档案",
    });
  } else {
    ok(report, {
      id: "online:noise-json",
      suite: "online",
      layer: "integration",
      title: "JSON 清单 30 页正文 100% 保留，噪音剔除",
      details: `${probe.pageCount} pages`,
    });
  }

  const htmlProbe = await invoke(page, "test_online_connection", {
    url: `${fixture.origin}/gallery-noise.html`,
  });
  if (!htmlProbe.ok || htmlProbe.pageCount !== 30) {
    fail(report, {
      id: "online:noise-html",
      suite: "online",
      layer: "integration",
      title: "HTML 图集未从 30 页正文中剔除站点 chrome",
      severity: "P1",
      details: JSON.stringify(htmlProbe),
      location: "src-tauri/src/online/html.rs",
      expected: "保留 30 张正文，剔除 header/nav/aside/footer 与主容器内小图",
      actual: `${htmlProbe.pageCount} 页 · ${htmlProbe.message}`,
      rootCause: "DOM 容器降权或尺寸门槛缺失",
      fix: "检查 chrome 追踪、负面词与尺寸探测",
    });
  } else {
    ok(report, {
      id: "online:noise-html",
      suite: "online",
      layer: "integration",
      title: "HTML 图集 30 页正文 100% 保留，站点 chrome 剔除",
      details: `${htmlProbe.pageCount} pages`,
    });
  }

  const spread = await invoke(page, "test_online_connection", {
    url: `${fixture.origin}/manifest-spread.json`,
  });
  if (!spread.ok || spread.pageCount !== 3) {
    fail(report, {
      id: "online:spread",
      suite: "online",
      layer: "integration",
      title: "跨页大图被误杀或超宽广告未过滤",
      severity: "P1",
      details: JSON.stringify(spread),
      location: "src-tauri/src/online/filter.rs",
      expected: "800×1200 两页 + 1600×1200 跨页保留；2400×700 横幅剔除",
      actual: `${spread.pageCount} 页`,
      rootCause: "宽高比门槛或中位宽度策略错误",
      fix: "仅按 aspect > 2.8 拦横幅，跨页按宽高比豁免",
    });
  } else {
    ok(report, {
      id: "online:spread",
      suite: "online",
      layer: "integration",
      title: "跨页大图保留、超宽横幅剔除",
    });
  }

  // ---------- 一键标记 / 新章节自动拦截 / 恢复 ----------
  try {
    const promo1 = await resolveOk(
      page,
      `${fixture.origin}/manifest-promo-1.json`,
      report,
      "online:promo-resolve",
      "推广图章节解析",
    );
    const before = pageCount(promo1);
    const marked = await invoke(page, "mark_online_page_non_content", {
      bookId: promo1.id,
      pageIndex: 3,
    });
    const filteredAfterMark = await invoke(page, "get_filtered_pages", {
      bookId: promo1.id,
    });
    if (before !== 4 || pageCount(marked) !== 3 || filteredAfterMark.length !== 1) {
      fail(report, {
        id: "online:promo-mark",
        suite: "online",
        layer: "integration",
        title: "标记尾页推广图后未从当前章节移除",
        severity: "P1",
        details: JSON.stringify({ before, marked: pageCount(marked), filteredAfterMark }),
        location: "src-tauri/src/commands.rs mark_online_page_non_content",
        expected: "4 → 3 页，过滤抽屉 1 条",
        actual: JSON.stringify({ before, after: pageCount(marked), filtered: filteredAfterMark.length }),
      });
    } else {
      ok(report, {
        id: "online:promo-mark",
        suite: "online",
        layer: "integration",
        title: "标记推广图后当前章节立即移除并记录指纹",
      });
    }

    const promo2 = await invoke(page, "resolve_online_url", {
      url: `${fixture.origin}/manifest-promo-2.json`,
    });
    const filtered2 = await invoke(page, "get_filtered_pages", {
      bookId: promo2.id,
    });
    if (pageCount(promo2) !== 3 || filtered2.length !== 1) {
      fail(report, {
        id: "online:promo-learn",
        suite: "online",
        layer: "integration",
        title: "新章节同模板推广图未被自动拦截",
        severity: "P1",
        details: JSON.stringify({ pageCount: pageCount(promo2), filtered: filtered2 }),
        location: "src-tauri/src/commands.rs / online/filter.rs",
        expected: "新章节 3 张正文，推广图被 URL 模板规则拦截",
        actual: `${pageCount(promo2)} 页，过滤 ${filtered2.length}`,
        rootCause: "用户规则未持久化或未按 host 加载",
        fix: "确认 online_filter_rules 写入与 filter_memory_for 读取",
      });
    } else {
      ok(report, {
        id: "online:promo-learn",
        suite: "online",
        layer: "integration",
        title: "一次标记后新章节同模板推广图自动拦截",
      });
    }

    const restored = await invoke(page, "restore_online_filtered_page", {
      bookId: promo1.id,
      filteredIndex: 0,
    });
    const filteredRestored = await invoke(page, "get_filtered_pages", {
      bookId: promo1.id,
    });
    const promo2Again = await invoke(page, "resolve_online_url", {
      url: `${fixture.origin}/manifest-promo-2.json`,
    });
    const filtered2Again = await invoke(page, "get_filtered_pages", {
      bookId: promo2Again.id,
    });
    if (
      pageCount(restored) !== 4 ||
      filteredRestored.length !== 0 ||
      pageCount(promo2Again) !== 4 ||
      filtered2Again.length !== 0
    ) {
      fail(report, {
        id: "online:promo-restore",
        suite: "online",
        layer: "integration",
        title: "恢复为正文后未放宽阈值或仍误杀同模板图片",
        severity: "P1",
        details: JSON.stringify({
          restored: pageCount(restored),
          filteredRestored: filteredRestored.length,
          promo2: pageCount(promo2Again),
          filtered2: filtered2Again.length,
        }),
        location: "src-tauri/src/commands.rs restore_online_filtered_page",
        expected: "恢复后 4 页；新章节同模板也恢复 4 页",
        actual: JSON.stringify({ restored, promo2: pageCount(promo2Again) }),
      });
    } else {
      ok(report, {
        id: "online:promo-restore",
        suite: "online",
        layer: "integration",
        title: "恢复为正文并自动修正站点阈值",
      });
    }

    const status = await invoke(page, "get_online_filter_status");
    const exported = await invoke(page, "export_online_filter_rules");
    const parsed = JSON.parse(exported);
    if (
      status.siteProfiles < 1 ||
      status.rules < 1 ||
      !Array.isArray(parsed.rules) ||
      parsed.rules.length < 1
    ) {
      fail(report, {
        id: "online:filter-observability",
        suite: "online",
        layer: "integration",
        title: "提纯引擎统计/规则导出不可用",
        severity: "P2",
        details: JSON.stringify({ status, exported: exported.slice(0, 200) }),
        location: "src-tauri/src/db.rs filter_stats / export_online_filter_rules",
        expected: "站点档案≥1、规则≥1、导出含 rules",
        actual: JSON.stringify(status),
      });
    } else {
      ok(report, {
        id: "online:filter-observability",
        suite: "online",
        layer: "integration",
        title: "过滤统计与规则导出可用",
        details: `${status.siteProfiles} 档案 / ${status.rules} 规则`,
      });
    }
  } catch (error) {
    fail(report, {
      id: "online:promo-mark",
      suite: "online",
      layer: "integration",
      title: "标记/恢复链路异常",
      severity: "P1",
      details: error.stack || String(error),
      location: "src-tauri/src/commands.rs",
    });
  }

  // ---------- Telegram 公开频道 ----------
  try {
    const channel = await invoke(page, "resolve_telegram_channel", {
      url: "https://t.me/s/testchannel",
      before: null,
    });
    const kinds = channel.chapters.map((chapter) => chapter.kind).sort();
    const okChannel =
      channel.chapters.length === 3 &&
      channel.hasMore === true &&
      Number(channel.before) === 99 &&
      kinds.join(",") === "document,photos,telegraph";
    if (!okChannel) {
      fail(report, {
        id: "online:telegram-channel",
        suite: "online",
        layer: "integration",
        title: "Telegram 频道章节列表/分页/闲聊过滤不正确",
        severity: "P1",
        details: JSON.stringify(channel),
        location: "src-tauri/src/online/telegram.rs",
        expected: "3 章（相册/Telegraph/压缩包），before=99，hasMore=true，纯文本与贴纸被剔除",
        actual: JSON.stringify({ chapters: channel.chapters, before: channel.before, hasMore: channel.hasMore }),
      });
    } else {
      ok(report, {
        id: "online:telegram-channel",
        suite: "online",
        layer: "integration",
        title: "Telegram 频道章节、分页与闲聊过滤正确",
      });
    }

    const telegramBook = await invoke(page, "resolve_online_url", {
      url: "https://t.me/testchannel/102",
    });
    if (pageCount(telegramBook) !== 3) {
      fail(report, {
        id: "online:telegram-message",
        suite: "online",
        layer: "integration",
        title: "Telegram 相册消息未解析为正文页",
        severity: "P1",
        details: JSON.stringify(telegramBook),
        location: "src-tauri/src/online/telegram.rs",
        expected: "3 张相册图，头像/贴纸剔除",
        actual: `${pageCount(telegramBook)} 页`,
      });
    } else {
      const read = await invoke(page, "get_page", {
        bookId: telegramBook.id,
        index: 0,
        maxWidth: 800,
        maxHeight: 1200,
      });
      if (!read?.dataUrl?.startsWith("data:image/")) {
        fail(report, {
          id: "online:telegram-refresh",
          suite: "online",
          layer: "integration",
          title: "Telegram CDN 403 后未通过消息锚点自愈",
          severity: "P1",
          details: JSON.stringify({ pages: pageCount(telegramBook), read: read?.mime }),
          location: "src-tauri/src/source.rs OnlineSource / telegram::refresh_page_url",
          expected: "首次请求 403 后静默刷新并返回图片",
          actual: "无法读取第 1 页",
        });
      } else {
        ok(report, {
          id: "online:telegram-refresh",
          suite: "online",
          layer: "integration",
          title: "Telegram CDN 403 后按消息锚点自愈",
        });
      }
    }

    const telegraph = await invoke(page, "resolve_online_url", {
      url: "https://telegra.ph/QA-Test-01",
    });
    if (pageCount(telegraph) !== 3) {
      fail(report, {
        id: "online:telegram-telegraph",
        suite: "online",
        layer: "integration",
        title: "Telegraph 章节图片未正确提纯",
        severity: "P1",
        details: JSON.stringify(telegraph),
        location: "src-tauri/src/online/telegram.rs",
        expected: "3 张正文；96×96 logo 剔除",
        actual: `${pageCount(telegraph)} 页`,
      });
    } else {
      ok(report, {
        id: "online:telegram-telegraph",
        suite: "online",
        layer: "integration",
        title: "Telegraph 章节正文提纯正确",
      });
    }

    const doc = await invoke(page, "download_telegram_document", {
      url: `${fixture.origin}/files/QA_Telegram_download`,
      filename: "QA_Telegram.zip",
    });
    if (pageCount(doc) !== 4) {
      fail(report, {
        id: "online:telegram-document",
        suite: "online",
        layer: "integration",
        title: "Telegram 压缩包附件未下载并入库",
        severity: "P2",
        details: JSON.stringify(doc),
        location: "src-tauri/src/commands.rs download_telegram_document",
        expected: "下载 QA_Telegram.zip 并识别 4 页",
        actual: `${pageCount(doc)} 页`,
      });
    } else {
      ok(report, {
        id: "online:telegram-document",
        suite: "online",
        layer: "integration",
        title: "Telegram 压缩包附件下载并入库",
      });
    }
  } catch (error) {
    fail(report, {
      id: "online:telegram-channel",
      suite: "online",
      layer: "integration",
      title: "Telegram 链路异常",
      severity: "P1",
      details: error.stack || String(error),
      location: "src-tauri/src/online/telegram.rs",
    });
  }

  // ---------- 前端 UI：频道章节面板 + 阅读器过滤抽屉 ----------
  try {
    await ctx.goto("#/browser");
    await page.waitFor("!!document.getElementById('browser-url-input')", {
      timeout: 8000,
      label: "browser input",
    });
    await page.eval(`(() => {
      const el = document.getElementById("browser-url-input");
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, "https://t.me/s/testchannel");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await page.click('form button[type="submit"]');
    await page.waitFor(
      "!!document.querySelector('[data-testid=telegram-channel-panel]')",
      { timeout: 12_000, label: "telegram panel" },
    );
    const chapterRows = await page.eval(
      "document.querySelectorAll('[data-testid=telegram-chapter]').length",
    );
    if (chapterRows !== 3) {
      fail(report, {
        id: "online:telegram-ui",
        suite: "online",
        layer: "ui",
        title: "浏览器地址栏 Telegram 频道未展示 3 个章节",
        severity: "P1",
        details: `rows=${chapterRows}`,
        location: "src/pages/Browser.tsx / TelegramChannelPanel.tsx",
        expected: "相册、Telegraph、压缩包 3 行",
        actual: `${chapterRows} 行`,
      });
    } else {
      ok(report, {
        id: "online:telegram-ui",
        suite: "online",
        layer: "ui",
        title: "浏览器地址栏 Telegram 频道章节面板可用",
      });
    }

    const filterBook = await invoke(page, "resolve_online_url", {
      url: `${fixture.origin}/manifest-promo-1.json`,
    });
    await page.eval("window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); true");
    await ctx.goto(`#/reader/${encodeURIComponent(filterBook.id)}`);
    await page.waitFor("!!document.querySelector('[data-testid=reader-filter-mark]')", {
      timeout: 10_000,
      label: "reader filter mark",
    });
    await page.eval("window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); true");
    await page.click("[data-testid=reader-filter-mark]");
    await page.waitFor("!!document.querySelector('[data-testid=reader-filter-count]')", {
      timeout: 12_000,
      label: "reader filtered count",
    });
    await page.eval("window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); true");
    await page.click("[data-testid=reader-filter-count]");
    await page.waitFor("!!document.querySelector('[data-testid=filtered-pages-sheet]')", {
      timeout: 8000,
      label: "filtered sheet",
    });
    const restoreButtons = await page.eval(
      "document.querySelectorAll('[data-testid=restore-filtered-page]').length",
    );
    if (restoreButtons < 1) {
      fail(report, {
        id: "online:filter-drawer-ui",
        suite: "online",
        layer: "ui",
        title: "已过滤杂图抽屉没有恢复按钮",
        severity: "P1",
        details: `restoreButtons=${restoreButtons}`,
        location: "src/components/Reader/FilteredPagesSheet.tsx",
      });
    } else {
      await page.click("[data-testid=restore-filtered-page]");
      await page.waitFor(
        "!document.querySelector('[data-testid=reader-filter-count]')",
        { timeout: 12_000, label: "filtered count cleared" },
      );
      ok(report, {
        id: "online:filter-drawer-ui",
        suite: "online",
        layer: "ui",
        title: "阅读器可标记非正文并在抽屉中一键恢复",
      });
    }
  } catch (error) {
    fail(report, {
      id: "online:filter-drawer-ui",
      suite: "online",
      layer: "ui",
      title: "阅读器过滤 UI 链路异常",
      severity: "P1",
      details: error.stack || String(error),
      location: "src/pages/Reader.tsx / FilteredPagesSheet.tsx",
    });
  }

  // ---------- 错误与安全门禁 ----------
  for (const [name, endpoint, expectedText] of [
    ["403", "forbidden.json", "403"],
    ["损坏清单", "invalid.json", "清单"],
    ["空清单", "empty.json", "pages"],
  ]) {
    const result = await invokeSafe(page, "test_online_connection", {
      url: `${fixture.origin}/${endpoint}`,
    });
    const error = result.ok ? null : result.error;
    const probeResult = result.ok ? result.value : null;
    const rejected = error
      ? error.toLowerCase().includes(String(expectedText).toLowerCase())
      : probeResult?.ok === false &&
        String(probeResult.message || "")
          .toLowerCase()
          .includes(String(expectedText).toLowerCase());
    if (!rejected) {
      fail(report, {
        id: `online:error-${endpoint}`,
        suite: "online",
        layer: "integration",
        title: `在线 ${name} 未返回明确错误`,
        severity: "P1",
        details: error || JSON.stringify(probeResult),
        location: "src-tauri/src/online/http.rs / direct.rs",
        expected: `明确错误且包含 ${expectedText}`,
        actual: error || JSON.stringify(probeResult),
      });
    } else {
      ok(report, {
        id: `online:error-${endpoint}`,
        suite: "online",
        layer: "integration",
        title: `在线 ${name} 错误可读`,
      });
    }
  }

  const browserWindowPresent = (await ctx.targets()).some(
    (target) =>
      target.url.includes("browser") && target.url !== page.target.url,
  );
  if (browserWindowPresent) {
    fail(report, {
      id: "online:403-no-silent-browser",
      suite: "online",
      layer: "integration",
      title: "403 后不得静默打开浏览器/绕过验证",
      severity: "P0",
      details: "browser target exists",
      location: "src/pages/Browser.tsx / src-tauri/src/browser.rs",
      expected: "只显示失败与用户可选的辅助入口",
      actual: "检测到静默浏览器窗口",
    });
  } else {
    ok(report, {
      id: "online:403-no-silent-browser",
      suite: "online",
      layer: "integration",
      title: "403 后未静默打开浏览器",
    });
  }
}
