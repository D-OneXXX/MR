import { connectRecovery, connectMain, waitForTarget } from "../lib/cdp.mjs";
import { invoke } from "../lib/app.mjs";
import { classifyRecoveryClose, isCdpTimeoutError } from "../lib/reliability.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targetsOnPort(ctx) {
  return ctx.targets();
}

async function recoveryTargetStillPresentAfter(ctx, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const still = (await targetsOnPort(ctx)).some((target) =>
      target.url.includes("recovery.html"),
    );
    if (!still) return false;
    await sleep(200);
  }
  return true;
}

async function closeRecovery(ctx, existingPage = null) {
  const targets = await targetsOnPort(ctx);
  const recovery = targets.find((target) => target.url.includes("recovery.html"));
  if (!recovery) return true;

  let page = existingPage;
  if (!page) {
    try {
      page = await connectRecovery(ctx.cdpPort);
    } catch (error) {
      // 窗口正在关闭时，CDP 连接可能先失败；以 target 是否消失为准。
      if (isCdpTimeoutError(error) && !(await recoveryTargetStillPresentAfter(ctx, 2500))) {
        return true;
      }
      throw error;
    }
  }

  let commandTimedOut = false;
  try {
    await invokeResilient(page, "resilience_close_recovery");
  } catch (error) {
    // 关闭命令可能先销毁窗口再回包；只有 target 仍存在时才算失败。
    if (!isCdpTimeoutError(error)) throw error;
    commandTimedOut = true;
  }
  await page.close().catch(() => {});

  const targetPresent = await recoveryTargetStillPresentAfter(ctx);
  const outcome = classifyRecoveryClose({ targetPresent, commandTimedOut });
  if (outcome === "closed") return true;
  throw new Error(
    outcome === "timeout-and-open"
      ? "恢复窗口关闭命令超时且 target 仍存在"
      : "恢复窗口关闭命令完成但 target 仍存在",
  );
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
  // 恢复窗先渲染 loading shell，再异步取 get_recovery_context；CI 上
  // 只等正文长度会把 "Loading…" 误当成已完成，随后读到空原因。
  await page
    .waitFor(
      `!document.body.innerText.includes("Loading") && !document.body.innerText.includes("加载中")`,
      { timeout: 12_000, label: "recovery context loaded" },
    )
    .catch(() => {});
  return { page, target };
}

/**
 * 韧性 invoke：安全模式阶段会重建主窗口，新 WebView 可能在几秒内不响应 CDP。
 * 这里对「CDP Runtime.evaluate 超时」做有限重试——只消除**时序抖动**，
 * 断言强度不变（重试后仍失败照样判失败）。
 */
async function invokeResilient(page, command, args = {}, attempts = 3) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await invoke(page, command, args);
    } catch (error) {
      lastError = error;
      if (!String(error).includes("超时")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

export async function runChaosSuite(ctx, report) {
  let page = ctx.page;
  await ctx.setLocale("en");
  page = ctx.page;
  // 恢复窗必须继承主窗主题/语言：先落盘 dark 偏好再触发恢复窗。
  // 同窗口 localStorage.setItem 不触发 StorageEvent，因此这里验证恢复窗
  // 启动期的跨窗口读取，不额外派发伪造事件。
  await ctx.setTheme("dark");
  page = ctx.page;
  await ctx.goto("#/");
  await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });

  note(report, "chaos stage: rage-click");
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
    // 诊断探针（只读）：记录连点**到达页面**的时间线，以及检测窗口内是否发生
    // 「有意义的 DOM 状态变化」（与产品检测器同一套 attributeFilter）。
    // hosted 与本地的差异必须能落到这两类证据上，不能靠猜。
    await page
      .eval(`(() => {
        window.__qaRage = { clicks: [], mutations: [], startedAt: performance.now() };
        window.addEventListener(
          "click",
          (event) => {
            window.__qaRage.clicks.push({
              t: Math.round(performance.now() - window.__qaRage.startedAt),
              x: event.clientX,
              y: event.clientY,
              tag: event.target && event.target.tagName,
              trusted: event.isTrusted,
              hash: location.hash,
            });
          },
          true,
        );
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type !== "attributes" || !record.attributeName) continue;
            const target = record.target;
            window.__qaRage.mutations.push({
              t: Math.round(performance.now() - window.__qaRage.startedAt),
              attr: record.attributeName,
              tag: target && target.tagName,
              id: (target && target.id) || "",
            });
          }
        });
        observer.observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: [
            "href",
            "aria-expanded",
            "aria-selected",
            "aria-pressed",
            "data-state",
            "open",
            "disabled",
            "hidden",
            "inert",
          ],
        });
        return true;
      })()`)
      .catch(() => false);
    const clickTimeline = [];
    for (let index = 0; index < 6; index += 1) {
      const started = Date.now();
      await page.mouseClick(point.x, point.y);
      clickTimeline.push(Date.now() - started);
      await sleep(80);
    }
    await sleep(1000);
    const rageProbe = await page
      .eval(`(() => {
        const probe = window.__qaRage;
        if (!probe) return null;
        return {
          clicks: probe.clicks,
          mutations: probe.mutations.slice(0, 20),
          mutationCount: probe.mutations.length,
        };
      })()`)
      .catch(() => null);
    const rageEvidence = {
      point,
      dispatchMs: clickTimeline,
      probe: rageProbe,
    };
    note(report, `chaos rage-click 诊断：${JSON.stringify(rageEvidence)}`);
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
        details: JSON.stringify(rageEvidence),
        location: "src/features/resilience/rageClick.ts:60-172",
        expected: "5 次/1500ms/30px 无状态变化后打开 recovery",
        actual: "未出现 recovery target",
      });
    } else {
      // 恢复原因由异步 IPC 填充；给慢速 CI 一个明确的就绪条件，
      // 超时仍由下面的原因断言判失败。
      await recovery.page
        .waitFor(`document.body.innerText.includes("Repeated clicks")`, {
          timeout: 12_000,
          label: "rage-click recovery reason",
        })
        .catch(() => {});
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

      // 恢复窗跨窗口偏好：主窗 mr-theme=dark / mr-locale=en 必须被继承。
      const prefs = await recovery.page.eval(`(() => {
        const text = document.body.innerText || "";
        return {
          theme: document.documentElement.dataset.theme,
          themeMode: document.documentElement.dataset.themeMode,
          lang: document.documentElement.lang,
          english: /Recovery & diagnostics|Isolated recovery window|Repeated clicks with no response/.test(text),
          storedTheme: localStorage.getItem("mr-theme"),
          storedLocale: localStorage.getItem("mr-locale"),
          text: text.slice(0, 300),
        };
      })()`);
      if (prefs.theme !== "dark" || prefs.lang !== "en" || !prefs.english) {
        fail(report, {
          id: "chaos:recovery-prefs",
          suite: "chaos",
          layer: "chaos",
          title: "恢复窗未继承主窗主题/语言",
          severity: "P1",
          details: JSON.stringify(prefs, null, 2),
          location: "src/recovery/main.tsx / recovery.html",
          expected:
            "主窗 mr-theme=dark、mr-locale=en 后打开的恢复窗 dataset.theme=dark、lang=en，正文为英文 Recovery 文案",
          actual: JSON.stringify(prefs),
          rootCause: "恢复窗入口未挂载主题/语言 Provider，或只读取默认 zh-CN/light",
          fix: "恢复窗挂载 ThemeProvider/I18nProvider（或等价启动同步），监听 storage 事件",
        });
      } else {
        ok(report, {
          id: "chaos:recovery-prefs",
          suite: "chaos",
          layer: "chaos",
          title: "恢复窗继承主窗 dark 主题与 en 语言",
          details: `theme=${prefs.theme} lang=${prefs.lang} stored=${prefs.storedTheme}/${prefs.storedLocale}`,
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
      await closeRecovery(ctx, recovery.page);
    }
  }

  note(report, "chaos stage: freeze");
  // ---------- Freeze → independent recovery → user-authorized reload ----------
  let freezeStage = "reconnect-before-freeze";
  try {
    await ctx.reconnectMain();
    page = ctx.page;
    freezeStage = "targets-before";
    const targetsBefore = await targetsOnPort(ctx);
    const mainBefore = targetsBefore.find((target) => target.url.includes("localhost:1420/") && !target.url.includes("recovery.html"));
    freezeStage = "freeze-main";
    await freezeMain(page);
    await sleep(7200);
    freezeStage = "wait-recovery";
    const targetsAfter = await targetsOnPort(ctx);
    const mainAfter = targetsAfter.find((target) => target.url.includes("localhost:1420/") && !target.url.includes("recovery.html"));
    // 6s 是产品判定阈值；Windows 冷启动/杀软扫描下恢复窗 target 暴露
    // 可能再花几秒，给 CDP 发现留 12s，仍由窗口内容断言 6s 判定是否生效。
    const recovery = await waitForRecovery(ctx, 12000);
    freezeStage = "assert-recovery";
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
    freezeStage = "reload-view";
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
    freezeStage = "close-recovery";
    await closeRecovery(ctx, recovery.page);
    freezeStage = "reconnect-after-reload";
    await ctx.reconnectMain();
  } catch (error) {
    fail(report, {
      id: "chaos:freeze-suite",
      suite: "chaos",
      layer: "chaos",
      title: "主线程死锁自动恢复链路无法完成",
      severity: "P0",
      details: `stage=${freezeStage}\n${error.stack || error.message}`,
      location: "src-tauri/src/resilience.rs / src/recovery/RecoveryApp.tsx",
      rootCause: "恢复窗口、CDP 或主窗口重建异常",
      fix: "查看 QA artifact 与应用日志",
    });
    return;
  }

  note(report, "chaos stage: safe-mode");
  // ---------- Safe mode from a real frozen main ----------
  try {
    await ctx.reconnectMain();
    await ctx.goto("#/");
    const safeBefore = await invokeResilient(ctx.page, "get_safe_mode_state");
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
    const recovery = await waitForRecovery(ctx, 12000);
    await recovery.page.clickText("Enter safe mode");
    await sleep(3000);
    await ctx.reconnectMain();
    await ctx.page.waitFor(
      "document.documentElement.dataset.safeMode === 'true'",
      { timeout: 10_000, label: "safe mode dataset" },
    );
    const safe = await invokeResilient(ctx.page, "get_safe_mode_state");
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
    await closeRecovery(ctx, recovery.page);
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
  note(
    report,
    "恢复窗偏好：触发前主窗已落盘 mr-theme=dark / mr-locale=en，验证恢复窗启动期跨窗口读取（未派发伪造 StorageEvent）",
  );
}
