import path from "node:path";
import { invoke, invokeSafe } from "../lib/app.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const CLS_PROBE = `(() => {
  window.__qaShift = 0;
  if (window.__qaShiftObserver) window.__qaShiftObserver.disconnect();
  window.__qaShiftObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__qaShift += entry.value;
    }
  });
  window.__qaShiftObserver.observe({ type: "layout-shift", buffered: false });
  return true;
})()`;

const WEBTOON_LABEL = `(() => {
  for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/%/.test(text) && /\\d+\\s*\\/\\s*\\d+/.test(text)) return text;
  }
  for (const el of document.querySelectorAll("[data-reader-hud]")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/%/.test(text) && /\\d+\\s*\\/\\s*\\d+/.test(text)) return text;
  }
  return null;
})()`;

const PAGE_COUNTER = `(() => {
  for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) return text;
  }
  return null;
})()`;

function pageNumberFromLabel(label) {
  const match = String(label || "").match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { page: Number(match[1]), total: Number(match[2]) } : null;
}

export async function runReaderSuite(ctx, report) {
  const page = ctx.page;
  const byFragment = (fragment) => ctx.books.find((book) => book.title.includes(fragment));
  const local = byFragment("QA Local Folder");
  const cjk = byFragment("QA_CJK_Path");
  const archive = byFragment("QA_Archive");
  const webtoon = byFragment("QA Long Webtoon");

  const importFailures = [];
  for (const entry of ctx.imported) {
    const name = path.basename(entry.path);
    const result = entry.result;
    if (name.includes("Broken")) {
      const failed =
        result.failed === 1 ||
        result.items?.some((item) => item.status === "failed");
      if (!failed) importFailures.push(`${name} 未按失败处理`);
    } else if (!result.added && !result.restored && !result.skipped) {
      importFailures.push(`${name} 未入库`);
    }
  }
  if (importFailures.length) {
    fail(report, {
      id: "reader:import-formats",
      suite: "reader",
      layer: "integration",
      title: "文件夹 / zip / cbz / 损坏包导入应安全",
      severity: "P1",
      details: importFailures.join(" | "),
      location: "src-tauri/src/commands.rs",
      expected: "正常包可入库，损坏包返回可读失败且不崩溃",
      actual: importFailures.join(" | "),
    });
  } else {
    ok(report, {
      id: "reader:import-formats",
      suite: "reader",
      layer: "integration",
      title: "文件夹 / zip / cbz / 损坏包导入安全",
      details: `导入 ${ctx.imported.length} 个路径`,
    });
  }

  const natural = byFragment("QA Natural Order");
  if (!natural) {
    fail(report, {
      id: "reader:natural-order",
      suite: "reader",
      layer: "integration",
      title: "未补零页码的文件夹未入库",
      severity: "P1",
      details: "QA Natural Order fixture missing from list_books",
      location: "src-tauri/src/commands.rs: import_books",
      expected: "文件夹 1.png / 2.png / 10.png / 11.png 正常入库",
      actual: "书库中找不到该 fixture",
    });
  } else {
    let names = [];
    try {
      const entries = await invoke(page, "list_entries", { bookId: natural.id });
      names = Array.isArray(entries) ? entries.map((entry) => entry.name) : [];
    } catch (error) {
      names = [`<error:${String(error)}>`];
    }
    const expectedOrder = ctx.fixtures.expected.naturalOrder;
    if (JSON.stringify(names) !== JSON.stringify(expectedOrder)) {
      fail(report, {
        id: "reader:natural-order",
        suite: "reader",
        layer: "integration",
        title: "未补零页码按字典序排列（1,10,11,2）",
        severity: "P1",
        details: JSON.stringify({ names, expectedOrder }),
        location: "src-tauri/src/source.rs:112,165,382",
        expected: expectedOrder.join(" → "),
        actual: names.join(" → "),
        rootCause: "FolderSource/ZipSource 使用 Vec::sort() 字典序，未复用 natural_cmp",
        fix: "文件夹与 ZIP/CBZ 条目均改用 commands.rs 的自然排序比较器，并补零/非补零混合用例",
      });
    } else {
      ok(report, {
        id: "reader:natural-order",
        suite: "reader",
        layer: "integration",
        title: "未补零页码按自然序排列",
        details: names.join(" → "),
      });
    }
  }

  const naturalZip = byFragment("QA_Natural_20");
  const expectedArchiveOrder = ctx.fixtures.expected.naturalArchiveOrder;
  if (!naturalZip) {
    fail(report, {
      id: "reader:natural-order-cbz",
      suite: "reader",
      layer: "integration",
      title: "字典序写入的 20 页 CBZ 未入库",
      severity: "P1",
      details: "QA_Natural_20.cbz fixture missing from list_books",
      location: "src-tauri/src/commands.rs: import_books",
      expected: "CBZ 条目 1.png ... 20.png 正常入库",
      actual: "书库中找不到该 fixture",
    });
  } else {
    let names = [];
    try {
      const entries = await invoke(page, "list_entries", { bookId: naturalZip.id });
      names = Array.isArray(entries) ? entries.map((entry) => entry.name) : [];
    } catch (error) {
      names = [`<error:${String(error)}>`];
    }
    const orderOk = JSON.stringify(names) === JSON.stringify(expectedArchiveOrder);
    const firstRead = await invokeSafe(page, "get_page", {
      bookId: naturalZip.id,
      index: 0,
    });
    const tenthRead = await invokeSafe(page, "get_page", {
      bookId: naturalZip.id,
      index: 9,
    });
    const width = (result) =>
      result.ok ? Number(result.value?.orig_width ?? result.value?.origWidth ?? 0) : 0;
    const widths = ctx.fixtures.expected.naturalArchiveWidths;
    const firstOk = firstRead.ok && width(firstRead) === widths[1];
    const tenthOk = tenthRead.ok && width(tenthRead) === widths[10];
    if (!orderOk || !firstOk || !tenthOk) {
      fail(report, {
        id: "reader:natural-order-cbz",
        suite: "reader",
        layer: "integration",
        title: "字典序写入的 CBZ 未按自然序 1..20 排列",
        severity: "P1",
        details: JSON.stringify({
          names,
          expected: expectedArchiveOrder,
          first: { ok: firstRead.ok, width: width(firstRead), expected: widths[1], error: firstRead.error },
          tenth: { ok: tenthRead.ok, width: width(tenthRead), expected: widths[10], error: tenthRead.error },
        }),
        location: "src-tauri/src/source.rs: ZipSource/SourceHandle names.sort_by",
        expected: "list_entries = 1..20；第 1 页原宽 408、第 10 页原宽 480",
        actual: `${names.join(",")} · page1=${width(firstRead)} · page10=${width(tenthRead)}`,
        rootCause: "ZIP/CBZ 条目排序退回 Vec::sort() 字典序",
        fix: "ZipSource 与 SourceHandle 统一使用 natural_cmp",
      });
    } else {
      ok(report, {
        id: "reader:natural-order-cbz",
        suite: "reader",
        layer: "integration",
        title: "字典序写入的 CBZ 按自然序 1..20 排列",
        details: `${names.length} 页 · 第1页 408px · 第10页 480px`,
      });
    }
  }

  const naturalLabels = byFragment("QA Natural Chapters");
  const expectedLabelOrder = ctx.fixtures.expected.naturalLabelsOrder;
  if (!naturalLabels) {
    fail(report, {
      id: "reader:natural-order-labels",
      suite: "reader",
      layer: "integration",
      title: "第2话/第10话 命名夹具未入库",
      severity: "P2",
      details: "QA Natural Chapters fixture missing from list_books",
      location: "tests/qa/lib/fixtures.mjs",
      expected: expectedLabelOrder.join(" → "),
      actual: "书库中找不到该 fixture",
    });
  } else {
    let labelNames = [];
    try {
      const entries = await invoke(page, "list_entries", {
        bookId: naturalLabels.id,
      });
      labelNames = Array.isArray(entries) ? entries.map((entry) => entry.name) : [];
    } catch (error) {
      labelNames = [`<error:${String(error)}>`];
    }
    if (JSON.stringify(labelNames) !== JSON.stringify(expectedLabelOrder)) {
      fail(report, {
        id: "reader:natural-order-labels",
        suite: "reader",
        layer: "integration",
        title: "第10话排在第2话之前（章节命名未自然排序）",
        severity: "P1",
        details: JSON.stringify({ labelNames, expected: expectedLabelOrder }),
        location: "src-tauri/src/source.rs: FolderSource",
        expected: expectedLabelOrder.join(" → "),
        actual: labelNames.join(" → "),
        rootCause: "文件夹条目按字典序而非数字段排序",
        fix: "统一使用 natural_cmp 比较器",
      });
    } else {
      ok(report, {
        id: "reader:natural-order-labels",
        suite: "reader",
        layer: "integration",
        title: "第1/2/10/11话章节命名按自然序排列",
        details: labelNames.join(" → "),
      });
    }
  }

  if (naturalZip) {
    const readCounter = async (id) => {
      await page.waitFor("!!document.querySelector('.reader-img')", {
        timeout: 12_000,
        label: `reader ${id}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const label = await page.eval(PAGE_COUNTER);
      const parsed = pageNumberFromLabel(label);
      return { label, ...(parsed || {}) };
    };
    let first = null;
    let tenth = null;
    let uiError = null;
    try {
      await ctx.goto(`#/reader/${encodeURIComponent(naturalZip.id)}?page=1`);
      await page.waitFor(
        "!!document.querySelector('.reader-img[data-idx=\"0\"]')",
        { timeout: 12_000, label: "natural cbz page 1" },
      );
      first = await readCounter("page 1");
      await ctx.goto("#/");
      await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });
      await ctx.goto(`#/reader/${encodeURIComponent(naturalZip.id)}?page=10`);
      await page.waitFor(
        "!!document.querySelector('.reader-img[data-idx=\"9\"]')",
        { timeout: 12_000, label: "natural cbz page 10" },
      );
      tenth = await readCounter("page 10");
    } catch (error) {
      uiError = String(error);
    }
    const uiOk =
      first?.page === 1 &&
      first?.total === 20 &&
      tenth?.page === 10 &&
      tenth?.total === 20;
    if (!uiOk) {
      fail(report, {
        id: "reader:natural-order-reader",
        suite: "reader",
        layer: "e2e",
        title: "阅读器打开首屏/第 10 页时页码与自然序不一致",
        severity: "P1",
        details: JSON.stringify({ first, tenth, error: uiError }),
        location: "src/pages/Reader.tsx / src-tauri/src/source.rs",
        expected: "pages = 20；打开第 1 页显示 1/20，跳转第 10 页显示 10/20",
        actual: uiError || `${first?.label} → ${tenth?.label}`,
      });
    } else {
      ok(report, {
        id: "reader:natural-order-reader",
        suite: "reader",
        layer: "e2e",
        title: "阅读器第 1 页/第 10 页与自然序条目一致",
        details: `${first.label} → ${tenth.label}`,
      });
    }
    await ctx.goto("#/");
  }

  for (const [name, book, expectedPages] of [
    ["本地文件夹", local, ctx.fixtures.expected.folderPages],
    ["中文路径 CBZ", cjk, ctx.fixtures.expected.cjkPages],
    ["ZIP", archive, ctx.fixtures.expected.zipPages],
  ]) {
    if (!book) {
      fail(report, {
        id: "reader:book-materialized",
        suite: "reader",
        layer: "integration",
        title: `${name} 未出现在书库`,
        severity: "P1",
        details: "import_books 成功但 list_books 找不到 fixture",
        location: "src-tauri/src/commands.rs",
      });
      continue;
    }
    await ctx.goto(`#/reader/${encodeURIComponent(book.id)}`);
    await page.waitFor("!!document.querySelector('.reader-root')", { timeout: 8000 });
    await page.waitFor("!!document.querySelector('.reader-img')", { timeout: 12_000 });
    const state = await page.eval(`({
      pageCount: ${book.pageCount},
      image: !!document.querySelector(".reader-img"),
      root: !!document.querySelector(".reader-root"),
    })`);
    if (!state.root || !state.image || state.pageCount !== expectedPages) {
      fail(report, {
        id: "reader:book-materialized",
        suite: "reader",
        layer: "integration",
        title: `${name} 无法按页读取`,
        severity: "P1",
        details: JSON.stringify(state),
        location: "src-tauri/src/source.rs / src/pages/Reader.tsx",
        expected: `root + image + ${expectedPages} pages`,
        actual: JSON.stringify(state),
      });
    } else {
      ok(report, {
        id: "reader:book-materialized",
        suite: "reader",
        layer: "integration",
        title: `${name} 可读取（${expectedPages} 页）`,
      });
    }
  }

  if (local) {
    await ctx.goto(`#/reader/${encodeURIComponent(local.id)}`);
    await page.waitFor("!!document.querySelector('.reader-img')", { timeout: 10_000 });
    const modes = [];
    const observeMode = () =>
      page.eval(`({
        single: !!document.querySelector(".reader-pages:not(.reader-double)"),
        double: !!document.querySelector(".reader-double"),
        webtoon: !!document.querySelector(".webtoon-scroll"),
      })`);
    modes.push({ mode: "initial", state: await observeMode() });
    await page.key("f");
    await new Promise((resolve) => setTimeout(resolve, 350));
    modes.push({ mode: "double", state: await observeMode() });
    await page.key("f");
    await new Promise((resolve) => setTimeout(resolve, 500));
    modes.push({ mode: "webtoon", state: await observeMode() });
    const actual = modes.map(({ mode, state }) => ({ mode, ...state }));
    const good =
      actual[0].single && !actual[0].double && !actual[0].webtoon &&
      actual[1].double && !actual[1].webtoon &&
      actual[2].webtoon;
    if (!good) {
      fail(report, {
        id: "reader:mode-cycle",
        suite: "reader",
        layer: "e2e",
        title: "单页 / 双页 / 条漫三态切换失效",
        severity: "P1",
        details: JSON.stringify(actual),
        location: "src/pages/Reader.tsx:752-804",
        expected: "single → double → webtoon",
        actual: JSON.stringify(actual),
      });
    } else {
      ok(report, {
        id: "reader:mode-cycle",
        suite: "reader",
        layer: "e2e",
        title: "单页 / 双页 / 条漫三态切换正常",
      });
    }
  }

  if (local) {
    const spreadOrder = async (dir) => {
      await page.eval(`(() => {
        localStorage.setItem("mr-reader-mode", "double");
        localStorage.setItem("mr-wt-${local.id}", "double");
        localStorage.setItem("mr-reader-dir", ${JSON.stringify(dir)});
        location.hash = ${JSON.stringify(`#/reader/${encodeURIComponent(local.id)}?page=2`)};
        setTimeout(() => location.reload(), 60);
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await page.waitFor("document.querySelectorAll('.reader-img').length === 2", {
        timeout: 12_000,
        label: `double spread ${dir}`,
      });
      return page.eval(`[...document.querySelectorAll(".reader-img")].map((img) => Number(img.getAttribute("data-idx")))`);
    };
    const ltr = await spreadOrder("ltr");
    const rtl = await spreadOrder("rtl");
    if (JSON.stringify(ltr) !== JSON.stringify([0, 1]) || JSON.stringify(rtl) !== JSON.stringify([2, 1])) {
      fail(report, {
        id: "reader:direction",
        suite: "reader",
        layer: "e2e",
        title: "双页 LTR/RTL 视觉顺序不符合规范",
        severity: "P1",
        details: JSON.stringify({ ltr, rtl }),
        location: "src/components/Reader/spread.ts:14-31",
        expected: "同一 spread 的 LTR=[0,1]，RTL=[2,1]（RTL 右起，后页在视觉左侧）",
        actual: JSON.stringify({ ltr, rtl }),
      });
    } else {
      ok(report, {
        id: "reader:direction",
        suite: "reader",
        layer: "e2e",
        title: "双页 LTR/RTL 阅读方向正确",
      });
    }
  }

  if (!webtoon) {
    fail(report, {
      id: "reader:webtoon-suite",
      suite: "reader",
      layer: "e2e",
      title: "长条漫夹具未入库，无法执行 100+ 页压测",
      severity: "P0",
      details: "fixture QA Long Webtoon missing",
      location: "tests/qa/lib/fixtures.mjs",
    });
    return;
  }

  await page.eval(`(() => { localStorage.setItem("mr-wt-${webtoon.id}", "webtoon"); localStorage.setItem("mr-reader-mode", "webtoon"); localStorage.removeItem("mr-reader-dir"); return true; })()`);
  await ctx.goto(`#/reader/${encodeURIComponent(webtoon.id)}?page=80`);
  await page.waitFor("!!document.querySelector('.webtoon-stage')", { timeout: 15_000 });
  await page.waitFor("!!document.querySelector('.webtoon-tile img')", { timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.eval(CLS_PROBE);
  const before = await page.eval(`(() => {
    const scroller = document.querySelector(".webtoon-scroll");
    const stage = document.querySelector(".webtoon-stage");
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
      stageHeight: Number(stage?.style.height?.replace("px", "") || 0),
      tiles: document.querySelectorAll(".webtoon-tile").length,
      images: document.querySelectorAll(".webtoon-tile img").length,
      label: (() => { for (const el of document.querySelectorAll("[data-reader-hud] .mono")) { const t = (el.textContent || "").trim(); if (/%/.test(t) && /\\d+\\s*\\/\\s*\\d+/.test(t)) return t; } return null; })(),
      totalPages: ${webtoon.pageCount},
    };
  })()`);
  if (!before.scrollHeight || before.tiles > 30 || before.images > 20 || before.images === 0) {
    fail(report, {
      id: "reader:webtoon-iob",
      suite: "reader",
      layer: "stress",
      title: "条漫未进行视口外节点回收",
      severity: "P1",
      details: JSON.stringify(before),
      location: "src/components/Reader/Webtoon.tsx:858-930",
      expected: "DOM tile ≤30、图片 ≤20 且当前视口至少渲染 1 张",
      actual: JSON.stringify(before),
    });
  } else {
    ok(report, {
      id: "reader:webtoon-iob",
      suite: "reader",
      layer: "stress",
      title: "条漫视口外节点已回收",
      details: `tiles=${before.tiles}, images=${before.images}, pages=${webtoon.pageCount}`,
    });
  }

  await page.eval("window.__qaShift = 0; true");
  const rapid = await page.eval(`(async () => {
    const scroller = document.querySelector(".webtoon-scroll");
    if (!scroller) return { ok: false, reason: "no scroller" };
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const positions = [];
    for (let i = 0; i < 45; i += 1) {
      const top = Math.round((Math.sin(i * 1.7) * 0.5 + 0.5) * max);
      positions.push(top);
      scroller.scrollTop = top;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    scroller.scrollTop = Math.round(max * 0.55);
    const deadline = Date.now() + 3000;
    let loadedImages = 0;
    while (Date.now() < deadline) {
      const imgs = [...document.querySelectorAll(".webtoon-tile img")];
      loadedImages = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
      if (loadedImages > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      ok: true,
      lastTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      tiles: document.querySelectorAll(".webtoon-tile").length,
      images: document.querySelectorAll(".webtoon-tile img").length,
      loadedImages,
      cls: Number(window.__qaShift || 0),
      label: (() => { for (const el of document.querySelectorAll("[data-reader-hud] .mono")) { const t = (el.textContent || "").trim(); if (/%/.test(t) && /\\d+\\s*\\/\\s*\\d+/.test(t)) return t; } return null; })(),
    };
  })()`);
  if (!rapid.ok) {
    fail(report, {
      id: "reader:webtoon-rapid",
      suite: "reader",
      layer: "stress",
      title: "条漫极速滚动压测无法执行",
      severity: "P0",
      details: rapid.reason,
      location: "src/components/Reader/Webtoon.tsx",
    });
  } else {
    const stable = Math.abs(rapid.scrollHeight - before.scrollHeight) <= 2;
    const bounded = rapid.tiles <= 30 && rapid.images <= 20 && rapid.loadedImages > 0;
    const clsOk = rapid.cls <= 0.02;
    if (!stable || !bounded || !clsOk) {
      fail(report, {
        id: "reader:webtoon-rapid",
        suite: "reader",
        layer: "stress",
        title: "100+ 页极速滚动后当前视口持续空白",
        severity: "P1",
        details: JSON.stringify({ before, rapid }),
        location: "src/components/Reader/Webtoon.tsx:344-416",
        expected: "scrollHeight 稳定、tiles≤30、images≤20、当前视口已加载图片、CLS≤0.02",
        actual: JSON.stringify(rapid),
        rootCause:
          "ensureTiles 对每个中间滚动窗口立即发请求，无在飞上限/取消/最新窗口优先；后端 tile 请求串行，最新视口排在旧请求之后",
        fix: "滚动空闲 120ms 后再取窗；在飞≤4；按代际取消过期请求；最新窗口优先队列",
      });
    } else {
      ok(report, {
        id: "reader:webtoon-rapid",
        suite: "reader",
        layer: "stress",
        title: "100+ 页极速滚动无累计布局位移",
        details: `CLS=${rapid.cls.toFixed(4)}, tiles=${rapid.tiles}, images=${rapid.images}, loaded=${rapid.loadedImages}`,
      });
    }
  }

  // Show the HUD so its page label/slider are interactable.
  const hudState = async () =>
    page.eval(`(() => {
      const slider = document.querySelector('[data-reader-hud] [data-slot="slider"]');
      if (!slider) return { visible: false, reason: "no slider" };
      let node = slider;
      let lowestOpacity = 1;
      let inert = false;
      while (node) {
        const style = getComputedStyle(node);
        lowestOpacity = Math.min(lowestOpacity, Number(style.opacity) || 1);
        if (node.hasAttribute?.("inert")) inert = true;
        node = node.parentElement;
      }
      return { visible: lowestOpacity > 0.5 && !inert, opacity: lowestOpacity, inert };
    })()`);
  // Programmatic scroll/zoom deliberately auto-hides the HUD, so re-reveal it
  // through the same pointer gesture a user would make before touching the dock.
  const revealHud = async () => {
    let state = await hudState();
    for (let attempt = 0; attempt < 3 && !state.visible; attempt += 1) {
      // CDP mouse input does not always synthesize a React PointerEvent pointerup
      // in WebView2; dispatch the same pointerdown/up pair the component listens
      // for so we can test the actual slider interaction beneath it.
      await page.eval(`(() => {
        const el = document.querySelector(".webtoon-scroll");
        if (!el) return false;
        const base = { bubbles: true, cancelable: true, pointerId: 77, pointerType: "mouse", button: 0, buttons: 1, clientX: 320, clientY: 300 };
        el.dispatchEvent(new PointerEvent("pointerdown", base));
        el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 350));
      state = await hudState();
    }
    return state;
  };
  let hud = await revealHud();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const beforeAnchor = await page.eval(WEBTOON_LABEL);
  const beforePage = pageNumberFromLabel(beforeAnchor);
  const stripBefore = await page.eval(`document.querySelector(".webtoon-strip")?.style.width || ""`);
  for (let index = 0; index < 4; index += 1) {
    await page.eval(`(() => {
      const el = document.querySelector(".webtoon-scroll");
      el?.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await new Promise((resolve) => setTimeout(resolve, 450));
  const afterAnchor = await page.eval(WEBTOON_LABEL);
  const afterPage = pageNumberFromLabel(afterAnchor);
  const stripAfter = await page.eval(`document.querySelector(".webtoon-strip")?.style.width || ""`);
  if (!beforePage || !afterPage || beforePage.page !== afterPage.page) {
    fail(report, {
      id: "reader:webtoon-anchor",
      suite: "reader",
      layer: "stress",
      title: "条漫缩放后中心页码漂移",
      severity: "P1",
      details: JSON.stringify({ beforeAnchor, afterAnchor, stripBefore, stripAfter }),
      location: "src/components/Reader/Webtoon.tsx:543-580",
      expected: "宽度变化前后中心页一致",
      actual: `${beforeAnchor} -> ${afterAnchor}`,
      rootCause: "宽度变化使用的滚动锚点被浏览器钳制",
      fix: "使用旧布局 + 旧 scrollTop 计算中心锚点",
    });
  } else {
    ok(report, {
      id: "reader:webtoon-anchor",
      suite: "reader",
      layer: "stress",
      title: "条漫缩放保持中心页码",
      details: `${beforeAnchor} → ${afterAnchor}`,
    });
  }

  // Scrubber drag: 20% → 70%. Zoom above is a programmatic scroll and hides
  // the HUD again, so take a fresh visibility sample and re-reveal it.
  const sliderSelector = '[data-reader-hud] [data-slot="slider"]';
  hud = await revealHud();
  const sliderExists = await page.rect(sliderSelector);
  if (sliderExists && hud.visible) {
    const sliderBefore = await page.eval(`(() => {
      const dock = document.querySelector('[data-reader-hud]');
      const thumb = dock?.querySelector('[data-slot="slider-thumb"]');
      const slider = dock?.querySelector('[data-slot="slider"]');
      return {
        thumb: thumb?.getAttribute("aria-valuenow"),
        slider: slider?.getAttribute("aria-valuenow"),
        thumbBox: thumb ? (() => { const r = thumb.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null,
      };
    })()`);
    await page.drag(sliderSelector, 0.2, 0.72);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const afterScrub = await page.eval(WEBTOON_LABEL);
    const scrubPage = pageNumberFromLabel(afterScrub);
    if (!scrubPage || scrubPage.page <= (afterPage?.page ?? 0)) {
      fail(report, {
        id: "reader:webtoon-scrub",
        suite: "reader",
        layer: "stress",
        title: "条漫拖拽进度条未同步页码",
        severity: "P1",
        details: JSON.stringify({ before: afterAnchor, after: afterScrub, hud, sliderBefore }),
        location: "src/components/Reader/ProgressScrubber.tsx:26-83",
        expected: "拖到约 70% 后页码明显前进",
        actual: String(afterScrub),
      });
    } else {
      ok(report, {
        id: "reader:webtoon-scrub",
        suite: "reader",
        layer: "stress",
        title: "条漫拖拽进度条与页码同步",
        details: `${afterAnchor} → ${afterScrub}`,
      });
    }
  } else {
    fail(report, {
      id: "reader:webtoon-scrub",
      suite: "reader",
      layer: "stress",
      title: "条漫进度滑杆不可交互",
      severity: "P1",
      details: `HUD 中找不到可交互的 [data-slot=slider]：${JSON.stringify(hud)}`,
      location: "src/components/Reader/ProgressScrubber.tsx",
    });
  }

  await ctx.goto("#/");
  note(report, "阅读器压测使用隔离数据目录与 125 页长条漫夹具");
}
