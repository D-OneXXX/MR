import fs from "node:fs";
import path from "node:path";
import { resizeNativeWindow } from "../lib/native-window.mjs";
import { invoke } from "../lib/app.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const LOCALES = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"];

const LAYOUT_PROBE = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const pills = [];
  for (const el of document.querySelectorAll("button, a, [role=tab], .rounded-full")) {
    if (!visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).whiteSpace === "nowrap") {
      pills.push({ text: (el.textContent || "").trim().slice(0, 60), scroll: el.scrollWidth, client: el.clientWidth, html: el.tagName.toLowerCase() });
    }
  }
  const tabs = [...document.querySelectorAll("[role=tab]")].filter(visible).map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || "").trim(), top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) };
  });
  const topRight = [...document.querySelectorAll("header a, header button")].filter(visible).map((el) => Math.round(el.getBoundingClientRect().right));
  const cjk = [];
  if (document.documentElement.lang === "en") {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || "").trim();
      if (!text || !/[\\u3400-\\u9fff]/.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      if (parent.closest("textarea,pre,code,script,style,[data-i18n-ignore]")) continue;
      cjk.push({ text: text.slice(0, 80), tag: parent.tagName.toLowerCase(), cls: String(parent.className).slice(0, 80) });
    }
  }
  const missingKey = [...document.querySelectorAll("body *")].filter(visible).map((el) => (el.textContent || "").trim()).filter((text) => /^(diagnostics|updates|privacy|settings|reader|safeMode|recovery|support|errorBoundary|library|browser)\\.[a-zA-Z0-9_.]+$/.test(text)).slice(0, 20);
  const rootStyle = getComputedStyle(document.documentElement);
  return { overflow, pills: pills.slice(0, 20), tabs, topRight, cjk: cjk.slice(0, 20), missingKey, inner: [innerWidth, innerHeight], lang: document.documentElement.lang, theme: document.documentElement.dataset.theme, bgToken: rootStyle.getPropertyValue("--sh-background").trim(), bodyBg: getComputedStyle(document.body).backgroundColor };
})()`;

const CONTRAST_PROBE = `(() => {
  const parse = (value) => {
    const match = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(/[,/ ]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  };
  const composite = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = (color) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const ratio = (a, b) => {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.5 && r.width > 1 && r.height > 1;
  };
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const baseBg = bodyBg.a < 1 ? { r: 255, g: 255, b: 255, a: 1 } : bodyBg;
  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    if (el.closest("[disabled],[aria-disabled=true],[inert],[aria-hidden=true]")) continue;
    // The brand lockup is a logotype (WCAG 1.4.3 exempts logotypes).
    if (el.closest('header a[aria-label*="Moyu"]')) continue;
    if (el.matches("input,textarea,select,option,script,style,pre,code")) continue;
    const directText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim());
    if (!directText) continue;
    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize) || 0;
    if (fontSize < 10) continue;
    let fg = parse(style.color);
    if (!fg) continue;
    // 从根到元素逐层合成半透明背景；不能因为祖先 0.8 alpha 就跳过，
    // 那会把弹层/胶囊的半透明遮罩误当成底色。
    const layers = [];
    let parent = el;
    while (parent) {
      const candidate = parse(getComputedStyle(parent).backgroundColor);
      if (candidate && candidate.a > 0) layers.push(candidate);
      parent = parent.parentElement;
    }
    let bg = baseBg;
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      bg = composite(layers[i], bg);
    }
    if (fg.a < 1) fg = composite(fg, bg);
    const c = ratio(fg, bg);
    const large = fontSize >= 24 || (fontSize >= 18.66 && Number(style.fontWeight) >= 700);
    const minimum = large ? 3 : 4.5;
    if (c < minimum) {
      const key = (el.textContent || "").trim() + "|" + style.color + "|" + style.fontSize;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ text: (el.textContent || "").trim().slice(0, 70), ratio: Number(c.toFixed(2)), min: minimum, color: style.color, background: \`rgba(\${bg.r},\${bg.g},\${bg.b},\${bg.a})\`, size: fontSize, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80) });
    }
  }
  return rows.slice(0, 25);
})()`;

async function currentLayout(page) {
  return page.eval(LAYOUT_PROBE);
}

async function contrastFailures(page) {
  return page.eval(CONTRAST_PROBE);
}

async function openSettingsTab(page, index) {
  await page.eval(
    `(() => { const tabs = [...document.querySelectorAll("[role=tab]")]; const tab = tabs[${index}]; if (tab) tab.click(); return tabs.length; })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export async function runVisualSuite(ctx, report) {
  let page = ctx.page;
  const dpr = await page.eval("window.devicePixelRatio || 1");
  const resized = resizeNativeWindow(ctx.appProcess.pid, 900 * dpr, 600 * dpr);
  if (!resized.ok) {
    fail(report, {
      id: "visual:native-resize",
      suite: "visual",
      layer: "ui",
      title: "900px 最小窗口布局检查无法执行",
      severity: "P2",
      details: resized.reason,
      location: "tests/qa/lib/native-window.mjs",
      expected: "真实窗口缩到 900×600 后执行六语种/双主题排版检查",
      actual: "窗口缩放失败，后续宽度断言不可信",
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 700));

  for (const locale of LOCALES) {
    await ctx.setLocale(locale);
    page = ctx.page;
    await ctx.goto("#/");
    await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });

    for (const theme of ["light", "dark"]) {
      await ctx.setTheme(theme);
      page = ctx.page;
      await ctx.goto("#/");
      await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });
      const screenshot = path.join(ctx.artifactDir, "screens", `${locale}-${theme}-library.png`);
      await page.screenshot(screenshot);

      const libraryLayout = await currentLayout(page);
      recordLayout(report, {
        id: "visual:layout-shell",
        locale,
        theme,
        page: "library",
        layout: libraryLayout,
        screenshot,
      });
      const expectedBg = theme === "light" ? "#eff8ff" : "#0b111e";
      if (libraryLayout.bgToken.toLowerCase() !== expectedBg) {
        fail(report, {
          id: "visual:theme-token",
          suite: "visual",
          layer: "visual",
          title: `主题背景令牌不符合规范（${locale}/${theme}）`,
          severity: "P2",
          details: `expected=${expectedBg}, token=${libraryLayout.bgToken}, body=${libraryLayout.bodyBg}`,
          location: "src/index.css:31-93",
          expected: expectedBg,
          actual: libraryLayout.bgToken,
        });
      } else {
        ok(report, {
          id: "visual:theme-token",
          suite: "visual",
          layer: "visual",
          title: `主题背景令牌正确（${locale}/${theme}）`,
        });
      }

      const contrast = await contrastFailures(page);
      recordContrast(report, { locale, theme, page: "library", rows: contrast });

      await ctx.goto("#/settings?tab=support");
      await page.waitFor("document.body.innerText.includes(\"AI\") || !!document.querySelector('[role=tab]')", { timeout: 8000 });
      const settingsLayout = await currentLayout(page);
      recordTabs(report, { locale, theme, layout: settingsLayout });
      if (theme === "light") {
        // 5 分区顺序：general=0 / network=1 / storage=2 / privacy=3 / about=4。
        await openSettingsTab(page, 3);
        const privacyContrast = await contrastFailures(page);
        recordContrast(report, { locale, theme, page: "settings-privacy", rows: privacyContrast });
      }

      await ctx.goto("#/browser");
      await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });
      const browserLayout = await currentLayout(page);
      recordLayout(report, {
        id: "visual:layout-browser",
        locale,
        theme,
        page: "browser",
        layout: browserLayout,
        screenshot: "",
      });
      recordCjk(report, locale, theme, "browser", browserLayout);
      for (const [surface, layout] of [
        ["library", libraryLayout],
        ["settings-support", settingsLayout],
      ]) {
        recordCjk(report, locale, theme, surface, layout);
      }
      if (libraryLayout.missingKey.length) {
        fail(report, {
          id: "visual:missing-keys",
          suite: "visual",
          layer: "ui",
          title: "界面不得直接显示未翻译的 i18n key",
          severity: "P1",
          details: libraryLayout.missingKey.join(", "),
          location: "src/i18n/locales",
        });
      } else {
        ok(report, {
          id: "visual:missing-keys",
          suite: "visual",
          layer: "ui",
          title: "未发现界面直接暴露 i18n key",
        });
      }
    }

    await ctx.setTheme("light");
    page = ctx.page;
    await ctx.goto("#/");
    const book = ctx.books.find((item) => item.title.includes("QA Local Folder"));
    if (book) {
      await ctx.goto(`#/reader/${encodeURIComponent(book.id)}`);
      await page.waitFor("!!document.querySelector('.reader-root')", { timeout: 12_000 });
      await page.waitFor("!!document.querySelector('.reader-img')", { timeout: 12_000 });
      const readerLayout = await currentLayout(page);
      if (readerLayout.overflow > 1 || readerLayout.pills.length > 0) {
        fail(report, {
          id: "visual:reader-overflow",
          suite: "visual",
          layer: "ui",
          title: `阅读器在 ${locale} 出现横向溢出或胶囊截断`,
          severity: "P2",
          details: JSON.stringify(readerLayout),
          location: "src/components/Reader/ReaderHudTop.tsx / ReaderDock.tsx",
          expected: "阅读器胶囊控件无截断",
          actual: `overflow=${readerLayout.overflow}, pills=${readerLayout.pills.length}`,
        });
      } else {
        ok(report, {
          id: "visual:reader-overflow",
          suite: "visual",
          layer: "ui",
          title: `阅读器 ${locale} 无横向溢出`,
        });
      }
      recordCjk(report, locale, "light", "reader", readerLayout);
      await ctx.goto("#/");
    }
  }

  // 规则过多时，规则列表必须留在卡片内并在卡片内滚动：视口高度一旦退化为
  // auto（父级只有 max-height），长规则就会冲出卡片、压到相邻区块。
  await ctx.setLocale("zh-CN");
  page = ctx.page;
  await ctx.goto("#/settings?tab=network");
  await page.waitFor("!!document.querySelector('main')", { timeout: 8000 });
  const overflowRules = Array.from({ length: 30 }, (_, index) => ({
    id: `qa-overflow-${index}`,
    host: "qa-overflow.example",
    action: index % 2 === 0 ? "block" : "allow",
    source: "user",
    pattern: {
      kind: "urlTemplate",
      template: `https://qa-overflow.example/chapter/${"segment-with-a-long-name-".repeat(6)}${index}/page-${index}.png`,
    },
    reason: "qa-overflow-regression",
    createdAt: "2026-10-25 00:00:00",
    hits: 0,
  }));
  try {
    const imported = await invoke(page, "import_online_filter_rules", {
      json: JSON.stringify(overflowRules),
    });
    await page.eval("setTimeout(() => location.reload(), 60); true");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await ctx.reconnectMain();
    page = ctx.page;
    await page.waitFor(
      "document.querySelectorAll('[data-slot=\"scroll-area-viewport\"] li').length >= 30",
      { timeout: 10000 },
    );
    const bounds = await page.eval(`(() => {
      const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
      const viewport = viewports
        .map((el) => ({ el, rows: el.querySelectorAll("li").length }))
        .sort((a, b) => b.rows - a.rows)[0]?.el;
      if (!viewport) return { found: false };
      const root = viewport.closest('[data-slot="scroll-area"]');
      const card = root ? root.parentElement : null;
      const viewRect = viewport.getBoundingClientRect();
      const cardRect = card ? card.getBoundingClientRect() : null;
      return {
        found: true,
        rows: viewport.querySelectorAll("li").length,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        escapesCard: cardRect ? viewRect.bottom > cardRect.bottom + 1 : true,
      };
    })()`);
    const bounded =
      bounds.found &&
      bounds.rows >= 30 &&
      !bounds.escapesCard &&
      bounds.clientHeight > 0 &&
      bounds.clientHeight <= 400;
    if (bounded) {
      ok(report, {
        id: "visual:rules-list-bounded",
        suite: "visual",
        layer: "visual",
        title: "规则列表过多时仍限制在卡片内滚动",
        details: `imported=${imported}, rows=${bounds.rows}, client=${bounds.clientHeight}, scroll=${bounds.scrollHeight}`,
      });
    } else {
      fail(report, {
        id: "visual:rules-list-bounded",
        suite: "visual",
        layer: "visual",
        title: "规则列表过多时仍限制在卡片内滚动",
        severity: "P2",
        details: `imported=${imported}, ${JSON.stringify(bounds)}`,
        location: "src/components/settings/OnlineFilterPanel.tsx / src/components/ui/scroll-area.tsx",
        expected: "30 条规则时列表高度不超过上限且不越过卡片边界",
        actual: JSON.stringify(bounds),
      });
    }
    await invoke(page, "reset_online_filter_rules", {});
  } catch (error) {
    fail(report, {
      id: "visual:rules-list-bounded",
      suite: "visual",
      layer: "visual",
      title: "规则列表溢出回归用例无法执行",
      severity: "P2",
      details: error.message || String(error),
      location: "tests/qa/suites/visual.mjs",
    });
  }

  await ctx.setLocale("zh-CN");
  page = ctx.page;
  await ctx.setTheme("system");
  page = ctx.page;
  const resolvedSystem = await page.eval(`({
    theme: document.documentElement.dataset.theme,
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
  })`);
  if (resolvedSystem.theme !== (resolvedSystem.prefersDark ? "dark" : "light")) {
    fail(report, {
      id: "visual:system-theme",
      suite: "visual",
      layer: "visual",
      title: "跟随系统主题解析错误",
      severity: "P2",
      details: JSON.stringify(resolvedSystem),
      location: "src/features/theme/ThemeProvider.tsx / index.html",
      expected: "跟随 prefers-color-scheme",
      actual: JSON.stringify(resolvedSystem),
    });
  } else {
    ok(report, {
      id: "visual:system-theme",
      suite: "visual",
      layer: "visual",
      title: "跟随系统主题解析正确",
    });
  }

  // Restore a deterministic final state for later suites.
  await ctx.setTheme("light");
  if (resized.ok) {
    resizeNativeWindow(ctx.appProcess.pid, 1200 * dpr, 800 * dpr);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function recordCjk(report, locale, theme, surface, layout) {
  if (locale !== "en") return;
  if (layout.cjk.length) {
    fail(report, {
      id: "visual:hardcoded-en",
      suite: "visual",
      layer: "ui",
      title: `英文界面残留硬编码中文（${surface}/${theme}）`,
      severity: "P2",
      details: layout.cjk.map((item) => `${item.tag}: ${item.text}`).join(" | "),
      location: "src/i18n/messages",
      expected: "英文模式下无中文 UI 文案",
      actual: layout.cjk.map((item) => item.text).join(" | "),
    });
  } else {
    ok(report, {
      id: "visual:hardcoded-en",
      suite: "visual",
      layer: "ui",
      title: `英文界面无硬编码中文（${surface}/${theme}）`,
    });
  }
}

function recordLayout(report, { id, locale, theme, page: surface, layout, screenshot }) {
  const label = `${locale}/${theme}/${surface}`;
  if (layout.overflow > 1) {
    fail(report, {
      id: `visual:layout-overflow`,
      suite: "visual",
      layer: "visual",
      title: `页面出现横向溢出（${label}）`,
      severity: "P2",
      details: `scrollWidth-clientWidth=${layout.overflow} @ ${screenshot}`,
      location: "src/index.css / src/components/shell",
      expected: "根页面水平溢出为 0",
      actual: `overflow=${layout.overflow}`,
    });
  } else {
    ok(report, {
      id: `visual:layout-overflow`,
      suite: "visual",
      layer: "visual",
      title: `根页面无横向溢出（${label}）`,
    });
  }
  if (layout.pills.length) {
    fail(report, {
      id: "visual:pill-clipping",
      suite: "visual",
      layer: "visual",
      title: `胶囊按钮文字被截断（${label}）`,
      severity: "P2",
      details: layout.pills.map((pill) => `${pill.text} ${pill.client}/${pill.scroll}`).join(" | "),
      location: "src/components/shell/TopBar.tsx",
      expected: "scrollWidth <= clientWidth",
      actual: JSON.stringify(layout.pills),
    });
  } else {
    ok(report, {
      id: "visual:pill-clipping",
      suite: "visual",
      layer: "visual",
      title: `胶囊按钮文字未截断（${label}）`,
    });
  }
  if (layout.topRight.some((right) => right > layout.inner[0] + 1)) {
    fail(report, {
      id: "visual:topbar-clip",
      suite: "visual",
      layer: "visual",
      title: `顶栏控件超出视口（${label}）`,
      severity: "P2",
      details: `innerWidth=${layout.inner[0]}, maxRight=${Math.max(...layout.topRight)}`,
      location: "src/components/shell/TopBar.tsx",
    });
  } else {
    ok(report, {
      id: "visual:topbar-clip",
      suite: "visual",
      layer: "visual",
      title: `顶栏控件未越界（${label}）`,
    });
  }
}

function recordTabs(report, { locale, theme, layout }) {
  const labels = layout.tabs.map((tab) => tab.text).join(" / ");
  const uniqueRows = new Set(layout.tabs.map((tab) => tab.top));
  const maxRight = Math.max(0, ...layout.tabs.map((tab) => tab.right));
  if (layout.tabs.length !== 5 || uniqueRows.size !== 1 || maxRight > layout.inner[0] + 1) {
    fail(report, {
      id: "visual:tabs-one-row",
      suite: "visual",
      layer: "visual",
      title: `设置 5 个 Tabs 在最小宽度必须单行完整可见（${locale}/${theme}）`,
      severity: "P2",
      details: `count=${layout.tabs.length}, rows=${uniqueRows.size}, maxRight=${maxRight}, inner=${layout.inner[0]}, tabs=${labels}`,
      location: "src/pages/Settings.tsx",
      expected: "5 个标签同一行且不越界",
      actual: JSON.stringify(layout.tabs),
    });
  } else {
    ok(report, {
      id: "visual:tabs-one-row",
      suite: "visual",
      layer: "visual",
      title: `设置 Tabs 单行完整（${locale}/${theme}）`,
    });
  }
}

function recordContrast(report, { locale, theme, page: surface, rows }) {
  if (rows.length) {
    fail(report, {
      id: "visual:contrast",
      suite: "visual",
      layer: "visual",
      title: `文字与背景对比度不足（${locale}/${theme}/${surface}）`,
      severity: "P2",
      details: rows
        .slice(0, 6)
        .map((row) => `${row.tag}.${row.cls.split(" ")[0]} "${row.text}" ${row.ratio}<${row.min}`)
        .join(" | "),
      location: "src/index.css / src/pages/Settings.tsx",
      expected: "普通文字对比度 >= 4.5:1，大号粗体 >= 3:1",
      actual: JSON.stringify(rows.slice(0, 6)),
    });
  } else {
    ok(report, {
      id: "visual:contrast",
      suite: "visual",
      layer: "visual",
      title: `文字对比度达标（${locale}/${theme}/${surface}）`,
    });
  }
}
