import { connectRecovery, connectMain, waitForTarget } from "../lib/cdp.mjs";
import { invoke } from "../lib/app.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targetsOnPort(ctx) {
  return ctx.targets();
}

async function closeRecovery(ctx) {
  const targets = await targetsOnPort(ctx);
  const recovery = targets.find((target) => target.url.includes("recovery.html"));
  if (!recovery) return false;
  const page = await connectRecovery(ctx.cdpPort);
  await invoke(page, "resilience_close_recovery");
  await page.close().catch(() => {});
  // 等旧 target 真正消失，避免后续测试连到已关闭/冻结的恢复窗。
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const still = (await targetsOnPort(ctx)).some((target) =>
      target.url.includes("recovery.html"),
    );
    if (!still) return true;
    await sleep(200);
  }
  return false;
}

async function freezeMain(page) {
  // Intentionally do not await completion: this renderer thread will stop
  // answering CDP while the Rust process stays alive.
  page
    .send(
      "Runtime.evaluate",
      { expression: "(() => { while (true) {} })()", awaitPromise: false },
      600,
    )
    .catch(() => {});
  await sleep(400);
}

async function waitForRecovery(ctx, timeout = 16_000) {
  const target = await waitForTarget(
    ctx.cdpPort,
    (entry) => entry.url.includes("recovery.html"),
    { timeout },
  );
  const page = await connectRecovery(ctx.cdpPort);
  await page.waitFor('document.body.innerText.length > 20', {
    timeout: 12_000,
    label: "recovery rendered",
  });
  return { page, target };
}

export async function runChaosSuite(ctx, report) {
  let page = ctx.page;
  await ctx.setLocale("en");
  page = ctx.page;
  await ctx.goto("#/");
  await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });

  // ---------- Rage click ----------
  const point = await page.eval(`(() => {
    for (let y = 300; y < 600; y += 30) {
      for (let x = 100; x < 800; x += 40) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest("button,a,input,select,textarea,label,[role=button],[role=tab],article,[data-reader-hud],[data-book-id]")) continue;
        const style = getComputedStyle(el);
        if (style.cursor === "pointer" || style.cursor === "grab") continue;
        if (el.closest("[data-rage-ignore]")) continue;
        return { x, y, tag: el.tagName };
      }
    }
    return null;
  })()`);
  if (!point) {
    fail(report, {
      id: "chaos:rage-click",
      suite: "chaos",
      layer: "chaos",
      title: "找不到可注入连点的非交互区域",
      severity: "P1",
      details: "visual test environment",
      location: "tests/qa/suites/chaos.mjs",
    });
  } else {
    const mainBefore = await targetsOnPort(ctx);
    const mainTarget = mainBefore.find((target) => target.url.includes("localhost:1420/") && !target.url.includes("recovery.html"));
    for (let index = 0; index < 6; index += 1) {
      await page.mouseClick(point.x, point.y);
      await sleep(80);
    }
    await sleep(1000);
    let recovery = null;
    try {
      recovery = await waitForRecovery(ctx, 7000);
    } catch {
      recovery = null;
    }
    if (!recovery) {
      fail(report, {
        id: "chaos:rage-click",
        suite: "chaos",
        layer: "chaos",
        title: "1.5s 内 6 次无效区域连点未触发独立恢复窗口",
        severity: "P1",
        details: `point=${JSON.stringify(point)}`,
        location: "src/features/resilience/rageClick.ts:60-172",
        expected: "5 次/1500ms/30px 无状态变化后打开 recovery",
        actual: "未出现 recovery target",
      });
    } else {
      const body = await recovery.page.eval("document.body.innerText");
      const mainStillSame = (await targetsOnPort(ctx)).some((target) => target.id === mainTarget?.id);
      if (!body.includes("Repeated clicks") || !mainStillSame) {
        fail(report, {
          id: "chaos:rage-click",
          suite: "chaos",
          layer: "chaos",
          title: "连点恢复窗口触发原因或主窗口状态异常",
          severity: "P1",
          details: body.slice(0, 300),
          location: "src-tauri/src/resilience.rs:398-457",
          expected: "recovery 原因为 rageClick 且主窗口不自动处理",
          actual: body.slice(0, 300),
        });
      } else {
        ok(report, {
          id: "chaos:rage-click",
          suite: "chaos",
          layer: "chaos",
          title: "Rage Click 唤起独立恢复窗口且未静默处理",
        });
      }
      // "Keep waiting" must not close the recovery window.
      const buttons = await recovery.page.eval(`[...document.querySelectorAll("button")].map((button) => (button.textContent || "").trim())`);
      if (buttons.some((text) => text === "Keep waiting")) {
        await recovery.page.clickText("Keep waiting");
        await sleep(600);
        const stillThere = (await targetsOnPort(ctx)).some((target) => target.url.includes("recovery.html"));
        if (!stillThere) {
          fail(report, {
            id: "chaos:continue-waiting",
            suite: "chaos",
            layer: "chaos",
            title: "继续等待错误地自动关闭恢复窗口",
            severity: "P1",
            location: "src/recovery/RecoveryApp.tsx:94-100",
            expected: "窗口保持打开",
            actual: "recovery target 消失",
          });
        } else {
          ok(report, {
            id: "chaos:continue-waiting",
            suite: "chaos",
            layer: "chaos",
            title: "继续等待不刷新/不关闭",
          });
        }
      }
      await recovery.page.close().catch(() => {});
      await closeRecovery(ctx);
    }
  }

  // ---------- Freeze → independent recovery → user-authorized reload ----------
  try {
    const targetsBefore = await targetsOnPort(ctx);
    const mainBefore = targetsBefore.find((target) => target.url.includes("localhost:1420/") && !target.url.includes("recovery.html"));
    await freezeMain(page);
    await sleep(7200);
    const targetsAfter = await targetsOnPort(ctx);
    const mainAfter = targetsAfter.find((target) => target.url.includes("localhost:1420/") && !target.url.includes("recovery.html"));
    const recovery = await waitForRecovery(ctx, 6000);
    const body = await recovery.page.eval("document.body.innerText");
    const autoRestarted = mainAfter && mainBefore && mainAfter.id !== mainBefore.id;
    if (!body.includes("Main reader window timed out") || autoRestarted) {
      fail(report, {
        id: "chaos:recovery-window",
        suite: "chaos",
        layer: "chaos",
        title: "主线程死锁未触发独立恢复窗口或发生静默重启",
        severity: "P0",
        details: JSON.stringify({ autoRestarted, mainBefore: mainBefore?.id, mainAfter: mainAfter?.id, body: body.slice(0, 300) }),
        location: "src-tauri/src/resilience.rs:294-335",
        expected: "6s 无心跳后独立窗口出现，主窗口保持原目标直到用户操作",
        actual: body.slice(0, 300),
        rootCause: "看门狗判定/窗口创建失效",
        fix: "确保后台线程检查心跳并通过 WebviewWindowBuilder 创建 recovery，而不是自动重启",
      });
    } else {
      ok(report, {
        id: "chaos:recovery-window",
        suite: "chaos",
        layer: "chaos",
        title: "6s 主线程死锁触发独立恢复窗口",
        details: `main target unchanged=${mainAfter?.id === mainBefore?.id}`,
      });
    }
    await recovery.page.clickText("Reload view only");
    await sleep(2200);
    const frozenMainId = mainAfter?.id;
    const newMain = await waitForTarget(
      ctx.cdpPort,
      (target) =>
        target.url.includes("localhost:1420/") &&
        !target.url.includes("recovery.html") &&
        target.id !== frozenMainId,
      { timeout: 10_000 },
    );
    const recoveryStill = (await targetsOnPort(ctx)).some((target) => target.url.includes("recovery.html"));
    if (!newMain || !recoveryStill) {
      fail(report, {
        id: "chaos:reload-view",
        suite: "chaos",
        layer: "chaos",
        title: "重载当前视图失败或恢复窗口被自动关闭",
        severity: "P1",
        details: JSON.stringify({ newMain: newMain?.id, recoveryStill }),
        location: "src-tauri/src/resilience.rs:480-540",
        expected: "主窗口重建，恢复窗口保持",
        actual: "缺少目标或恢复窗口消失",
      });
    } else {
      ok(report, {
        id: "chaos:reload-view",
        suite: "chaos",
        layer: "chaos",
        title: "仅重载当前视图可恢复冻结主窗口",
      });
    }
    await recovery.page.close().catch(() => {});
    await closeRecovery(ctx);
    await ctx.reconnectMain();
  } catch (error) {
    fail(report, {
      id: "chaos:freeze-suite",
      suite: "chaos",
      layer: "chaos",
      title: "主线程死锁自动恢复链路无法完成",
      severity: "P0",
      details: error.stack || error.message,
      location: "src-tauri/src/resilience.rs / src/recovery/RecoveryApp.tsx",
      rootCause: "恢复窗口、CDP 或主窗口重建异常",
      fix: "查看 QA artifact 与应用日志",
    });
    return;
  }

  // ---------- Safe mode from a real frozen main ----------
  try {
    await ctx.goto("#/");
    const safeBefore = await invoke(ctx.page, "get_safe_mode_state");
    if (safeBefore.active) {
      fail(report, {
        id: "chaos:safe-mode-baseline",
        suite: "chaos",
        layer: "chaos",
        title: "独立测试环境启动时不应预置安全模式",
        severity: "P1",
        details: JSON.stringify(safeBefore),
        location: "tests/qa/lib/app.mjs",
      });
    }
    await freezeMain(ctx.page);
    await sleep(7200);
    const recovery = await waitForRecovery(ctx, 6000);
    await recovery.page.clickText("Enter safe mode");
    await sleep(3000);
    await ctx.reconnectMain();
    await ctx.page.waitFor(
      "document.documentElement.dataset.safeMode === 'true'",
      { timeout: 10_000, label: "safe mode dataset" },
    );
    const safe = await invoke(ctx.page, "get_safe_mode_state");
    const ui = await ctx.page.eval(`({
      safePill: !!document.querySelector("[data-safe-mode-pill]"),
      browserVisible: [...document.querySelectorAll("a")].some((a) => (a.getAttribute("href") || "").includes("/browser")),
      libraryBanner: document.body.innerText.includes("Safe mode is active"),
    })`);
    if (!safe.active || !ui.safePill || ui.browserVisible || !ui.libraryBanner) {
      fail(report, {
        id: "chaos:safe-mode",
        suite: "chaos",
        layer: "chaos",
        title: "用户确认后安全模式未完整降级",
        severity: "P1",
        details: JSON.stringify({ safe, ui }),
        location: "src/features/safeMode/SafeModeContext.tsx / src/components/shell/TopBar.tsx",
        expected: "active + 状态胶囊 + 隐藏浏览器 + 本地书库提示",
        actual: JSON.stringify({ safe, ui }),
      });
    } else {
      ok(report, {
        id: "chaos:safe-mode",
        suite: "chaos",
        layer: "chaos",
        title: "安全模式状态胶囊与在线隔离生效",
      });
    }

    const onlineBlocked = await ctx.page.eval(`(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("resolve_online_url", { url: "https://example.com/qa" });
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    })()`);
    if (!String(onlineBlocked).includes("安全模式")) {
      fail(report, {
        id: "chaos:safe-online-guard",
        suite: "chaos",
        layer: "chaos",
        title: "安全模式未在 Rust 命令层阻断在线直读",
        severity: "P1",
        details: String(onlineBlocked),
        location: "src-tauri/src/commands.rs:1494-1575",
        expected: "拒绝在线解析",
        actual: String(onlineBlocked),
      });
    } else {
      ok(report, {
        id: "chaos:safe-online-guard",
        suite: "chaos",
        layer: "chaos",
        title: "安全模式阻断在线直读命令",
      });
    }

    const book = ctx.books.find((item) => item.title.includes("QA Local Folder"));
    if (book) {
      await ctx.goto(`#/reader/${encodeURIComponent(book.id)}`);
      await ctx.page.waitFor("!!document.querySelector('.reader-img')", { timeout: 10_000 });
      const modes = await ctx.page.eval(`(() => {
        const labels = [...document.querySelectorAll("button")].map((button) => ({
          text: (button.textContent || "").trim(),
          pressed: button.getAttribute("aria-pressed"),
          disabled: button.getAttribute("aria-disabled"),
        })).filter((row) => row.text.startsWith("Single") || row.text.startsWith("Two") || row.text.startsWith("Webtoon"));
        return { labels, double: !!document.querySelector(".reader-double"), webtoon: !!document.querySelector(".reader-canvas-webtoon") };
      })()`);
      const singleLocked =
        !modes.double &&
        !modes.webtoon &&
        modes.labels.some((row) => row.text.startsWith("Single") && row.pressed === "true") &&
        modes.labels.filter((row) => !row.text.startsWith("Single")).every((row) => row.disabled === "true");
      if (!singleLocked) {
        fail(report, {
          id: "chaos:safe-single-page",
          suite: "chaos",
          layer: "chaos",
          title: "安全模式下阅读器未锁定基础单页",
          severity: "P1",
          details: JSON.stringify(modes),
          location: "src/pages/Reader.tsx:198-204 / ReaderDock.tsx:128-173",
          expected: "单页 active，双页/条漫不可用",
          actual: JSON.stringify(modes),
        });
      } else {
        ok(report, {
          id: "chaos:safe-single-page",
          suite: "chaos",
          layer: "chaos",
          title: "安全模式锁定本地单页阅读",
        });
      }
      const safePill = await ctx.page.rect("[data-safe-mode-pill]");
      if (!safePill) {
        fail(report, {
          id: "chaos:safe-exit-pill",
          suite: "chaos",
          layer: "chaos",
          title: "阅读器内安全模式胶囊不常驻",
          severity: "P1",
          location: "src/components/Reader/ReaderHudTop.tsx",
        });
      } else {
        ok(report, {
          id: "chaos:safe-exit-pill",
          suite: "chaos",
          layer: "chaos",
          title: "阅读器内安全模式胶囊常驻",
        });
      }
      // Return to the shell before exiting safe mode.
      await ctx.goto("#/");
    }
    await ctx.page.click("[data-safe-mode-pill]");
    await sleep(2200);
    await ctx.reconnectMain();
    const exited = await invoke(ctx.page, "get_safe_mode_state");
    if (exited.active) {
      fail(report, {
        id: "chaos:safe-exit",
        suite: "chaos",
        layer: "chaos",
        title: "一键退出安全模式失败",
        severity: "P1",
        location: "src/components/shell/SafeModePill.tsx:20-38",
        expected: "active=false 并恢复完整 UI",
        actual: JSON.stringify(exited),
      });
    } else {
      ok(report, {
        id: "chaos:safe-exit",
        suite: "chaos",
        layer: "chaos",
        title: "一键退出安全模式并恢复",
      });
    }
    await closeRecovery(ctx);
  } catch (error) {
    fail(report, {
      id: "chaos:safe-mode-suite",
      suite: "chaos",
      layer: "chaos",
      title: "安全模式自动回归无法完成",
      severity: "P0",
      details: error.stack || error.message,
      location: "src/recovery/RecoveryApp.tsx / src/features/safeMode",
    });
  }

  note(report, "混沌测试通过 CDP 注入 while(true) 与真实鼠标连点；主窗口重建经独立恢复窗点击触发");
}
