import { enableOnline, invoke, invokeSafe } from "../lib/app.mjs";
import { fail, ok } from "../lib/report.mjs";

const MB = 1024 * 1024;

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function runCacheSuite(ctx, report) {
  const page = ctx.page;
  const fixture = ctx.onlineFixture;
  if (!fixture) {
    fail(report, {
      id: "cache:fixture-missing",
      suite: "cache",
      layer: "infrastructure",
      title: "缓存用例缺少在线夹具",
      severity: "P0",
      location: "tests/qa/run-qa.mjs",
    });
    return;
  }

  await enableOnline(page);
  const original = await invoke(page, "get_settings");
  let restore = null;

  try {
    // ---------- 可调软上限：500MB-10GB，写回后即时反映在统计里 ----------
    const initial = number(original.diskCacheBudgetMb, 0);
    if (initial < 500 || initial > 10240) {
      fail(report, {
        id: "cache:budget-default",
        suite: "cache",
        layer: "integration",
        title: "磁盘缓存默认上限不在 500MB-10GB 区间",
        severity: "P1",
        location: "src-tauri/src/lib.rs Settings::default",
        expected: "diskCacheBudgetMb = 2048",
        actual: String(initial),
      });
    } else {
      ok(report, {
        id: "cache:budget-default",
        suite: "cache",
        layer: "integration",
        title: "磁盘缓存默认上限在允许区间",
        details: `${initial} MB`,
      });
    }

    const narrowed = { ...original, diskCacheBudgetMb: 512 };
    await invoke(page, "set_settings", { settings: narrowed });
    const reloaded = await invoke(page, "get_settings");
    const limitedStats = await invoke(page, "get_memory_stats");
    const persistOk =
      number(reloaded.diskCacheBudgetMb) === 512 &&
      number(limitedStats.diskCacheLimitBytes) === 512 * MB;
    if (!persistOk) {
      fail(report, {
        id: "cache:budget-persist",
        suite: "cache",
        layer: "integration",
        title: "磁盘缓存上限未持久化或未即时生效",
        severity: "P1",
        location: "src-tauri/src/commands.rs set_settings",
        expected: "get_settings=512；get_memory_stats.diskCacheLimitBytes=536870912",
        actual: JSON.stringify({
          setting: reloaded.diskCacheBudgetMb,
          limit: limitedStats.diskCacheLimitBytes,
        }),
      });
    } else {
      ok(report, {
        id: "cache:budget-persist",
        suite: "cache",
        layer: "integration",
        title: "磁盘缓存上限持久化并即时生效",
        details: `512 MB / ${limitedStats.diskCacheLimitBytes} bytes`,
      });
    }

    // ---------- 首次读页同时填充 render L2 + online 原图 L2 ----------
    const token = `qa-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const manifest = await invoke(page, "resolve_online_url", {
      url: `${fixture.origin}${fixture.protected.manifestPath}?token=${token}`,
    });
    await invoke(page, "set_progress", { bookId: manifest.id, page: 1 });
    const pageRead = await invokeSafe(page, "get_page", {
      bookId: manifest.id,
      index: 0,
    });
    const populated = await invoke(page, "get_memory_stats");
    const populatedOk =
      pageRead.ok &&
      number(populated.diskCacheBytes) > 0 &&
      number(populated.renderCacheBytes) > 0 &&
      number(populated.onlineCacheBytes) > 0;
    if (!populatedOk) {
      fail(report, {
        id: "cache:populate",
        suite: "cache",
        layer: "integration",
        title: "在线读页未同时写入渲染与在线原图磁盘缓存",
        severity: "P1",
        location: "src-tauri/src/source.rs OnlineSource::read_raw",
        expected: "get_page 成功且 disk/render/online 三项均 > 0",
        actual: JSON.stringify({
          read: pageRead.ok ? "ok" : pageRead.error,
          disk: populated.diskCacheBytes,
          render: populated.renderCacheBytes,
          online: populated.onlineCacheBytes,
        }),
      });
    } else {
      ok(report, {
        id: "cache:populate",
        suite: "cache",
        layer: "integration",
        title: "在线读页同时写入渲染与在线原图磁盘缓存",
        details: `disk=${populated.diskCacheBytes} · render=${populated.renderCacheBytes} · online=${populated.onlineCacheBytes}`,
      });
    }

    // ---------- 一键清空：只清派生缓存，进度与书库必须保留 ----------
    // get_page 会后台预取邻页；等它落地再清理，避免把在途写入误判为清理失败。
    await new Promise((resolve) => setTimeout(resolve, 600));
    const beforeClear = await invoke(page, "get_memory_stats");
    const cleared = await invoke(page, "clear_temp_cache");
    const afterClear = await invoke(page, "get_memory_stats");
    const bookAfter = await invoke(page, "get_book", { bookId: manifest.id });
    const progressKept = number(bookAfter.currentPage, -1) === 1;
    const clearOk =
      number(cleared.bytesFreed) > 0 &&
      number(cleared.files) > 0 &&
      number(afterClear.diskCacheBytes) === 0 &&
      number(afterClear.onlineCacheBytes) === 0 &&
      progressKept;
    if (!clearOk) {
      fail(report, {
        id: "cache:clear-isolated",
        suite: "cache",
        layer: "integration",
        title: "清空临时缓存未隔离 SQLite 进度或未真正释放磁盘",
        severity: "P1",
        location: "src-tauri/src/commands.rs clear_temp_cache",
        expected: "bytesFreed/files > 0；disk/online=0；currentPage 仍为 1",
        actual: JSON.stringify({
          bytesFreed: cleared.bytesFreed,
          files: cleared.files,
          before: beforeClear.diskCacheBytes,
          afterDisk: afterClear.diskCacheBytes,
          afterOnline: afterClear.onlineCacheBytes,
          currentPage: bookAfter.currentPage,
        }),
      });
    } else {
      ok(report, {
        id: "cache:clear-isolated",
        suite: "cache",
        layer: "integration",
        title: "清空临时缓存释放磁盘且保留阅读进度",
        details: `释放 ${cleared.bytesFreed} 字节 / ${cleared.files} 个文件`,
      });
    }

    // 清空后仍能重新取页，证明只删缓存、没有破坏源数据。
    const reread = await invokeSafe(page, "get_page", {
      bookId: manifest.id,
      index: 0,
    });
    if (!reread.ok) {
      fail(report, {
        id: "cache:reread",
        suite: "cache",
        layer: "integration",
        title: "清空缓存后无法重新取页",
        severity: "P1",
        location: "src-tauri/src/commands.rs get_page",
        expected: "重新下载并成功返回 dataUrl",
        actual: String(reread.error),
      });
    } else {
      ok(report, {
        id: "cache:reread",
        suite: "cache",
        layer: "integration",
        title: "清空缓存后可重新取页",
        details: "dataUrl 可再次取得",
      });
    }

    // ---------- 设置页可见：上限滑杆、占用进度、一键清空按钮 ----------
    await ctx.goto("#/settings");
    await page.waitFor("!!document.querySelector('[data-testid=settings-tab-cache]')", {
      timeout: 10_000,
      label: "settings cache tab",
    });
    await page.click("[data-testid=settings-tab-cache]");
    await page.waitFor("!!document.querySelector('[data-testid=disk-cache-usage]')", {
      timeout: 10_000,
      label: "disk cache panel",
    });
    const ui = await page.eval(`(() => {
      const slider = document.querySelector('#disk-cache-budget');
      const button = document.querySelector('[data-testid=clear-temp-cache]');
      const usage = document.querySelector('[data-testid=disk-cache-usage]');
      return {
        slider: !!slider,
        sliderMin: slider?.getAttribute('aria-valuemin') ?? slider?.min ?? null,
        sliderMax: slider?.getAttribute('aria-valuemax') ?? slider?.max ?? null,
        button: !!button,
        buttonDisabled: !!button?.disabled,
        usage: (usage?.textContent || '').replace(/\\s+/g, ' ').trim(),
        progress: !!document.querySelector('[data-slot=progress]'),
      };
    })()`);
    const uiOk =
      ui.slider &&
      ui.button &&
      !ui.buttonDisabled &&
      ui.usage.length > 0 &&
      ui.progress;
    if (!uiOk) {
      fail(report, {
        id: "cache:settings-ui",
        suite: "cache",
        layer: "e2e",
        title: "设置页缓管理缺少滑杆/占用/一键清空",
        severity: "P2",
        location: "src/pages/Settings.tsx",
        expected: "磁盘滑杆、占用进度与一键清空按钮均可见可用",
        actual: JSON.stringify(ui),
      });
    } else {
      ok(report, {
        id: "cache:settings-ui",
        suite: "cache",
        layer: "e2e",
        title: "设置页缓存管理控件可见可用",
        details: `min=${ui.sliderMin} max=${ui.sliderMax} usage=${ui.usage}`,
      });
    }
    await ctx.goto("#/");
  } finally {
    if (original && typeof original.diskCacheBudgetMb === "number") {
      restore = { ...original };
      try {
        await invoke(page, "set_settings", { settings: restore });
      } catch (error) {
        fail(report, {
          id: "cache:restore-settings",
          suite: "cache",
          layer: "integration",
          title: "缓存用例无法恢复原始设置",
          severity: "P2",
          location: "tests/qa/suites/cache.mjs",
          expected: `diskCacheBudgetMb=${original.diskCacheBudgetMb}`,
          actual: String(error),
        });
      }
    }
  }
}
