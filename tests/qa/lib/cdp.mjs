import fs from "node:fs";
import path from "node:path";

const KEY_CODES = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  " ": 32,
  f: 70,
  F: 70,
  w: 87,
  W: 87,
  k: 75,
  K: 75,
};

export async function listTargets(port, timeout = 3000) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

export async function waitForTarget(
  port,
  predicate,
  { timeout = 30_000, interval = 200 } = {},
) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const target = targets.find((entry) => entry.type === "page" && predicate(entry));
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `等待 CDP target 超时（${timeout}ms）${lastError ? `：${lastError.message}` : ""}`,
  );
}

export class CdpPage {
  constructor(target, port) {
    this.target = target;
    this.port = port;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  static async connect(target, port) {
    const page = new CdpPage(target, port);
    await page.open();
    return page;
  }

  get id() {
    return this.target.id;
  }

  async open() {
    if (typeof WebSocket !== "function") {
      throw new Error("当前 Node.js 不提供全局 WebSocket（需要 Node 22+）");
    }
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = message.id ? this.pending.get(message.id) : null;
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  send(method, params = {}, timeout = 10_000) {
    if (!this.socket) return Promise.reject(new Error("CDP 未连接"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { timeout = 10_000 } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeout,
    );
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "页面脚本异常";
      throw new Error(text);
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 10_000, interval = 100, label } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression, { timeout: 3000 })) return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(
      `等待条件超时${label ? `（${label}）` : ""}：${expression}${
        lastError ? `；最后错误：${lastError.message}` : ""
      }`,
    );
  }

  async screenshot(filePath) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
    return filePath;
  }

  async rect(selector) {
    return this.eval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
  }

  async mouseClick(x, y, { clickCount = 1 } = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount,
    });
  }

  async click(selector, { ratioX = 0.5, ratioY = 0.5 } = {}) {
    const rect = await this.rect(selector);
    if (!rect) throw new Error(`点击目标不可见：${selector}`);
    const x = rect.x + rect.width * ratioX;
    const y = rect.y + rect.height * ratioY;
    await this.mouseClick(x, y);
    return { x, y, rect };
  }

  async clickText(text, { timeout = 5000 } = {}) {
    const encoded = JSON.stringify(text);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rect = await this.eval(`(() => {
        const nodes = [...document.querySelectorAll("button,a,[role=button],[role=tab],[role=menuitem]")];
        const element = nodes.find((node) => (node.textContent || "").trim().includes(${encoded}));
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      if (rect) {
        await this.mouseClick(rect.x, rect.y);
        return rect;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`找不到文本可点击元素：${text}`);
  }

  async key(key, { modifiers = 0 } = {}) {
    const code = KEY_CODES[key] ?? 0;
    const base = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      modifiers,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      text: key.length === 1 && !modifiers ? key : undefined,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async wheel(x, y, deltaY, { ctrl = false } = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      modifiers: ctrl ? 2 : 0,
    });
  }

  async drag(selector, fromRatio, toRatio) {
    const rect = await this.rect(selector);
    if (!rect) throw new Error(`拖拽目标不可见：${selector}`);
    const y = rect.y + rect.height / 2;
    const fromX = rect.x + rect.width * fromRatio;
    const toX = rect.x + rect.width * toRatio;
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX,
      y,
      button: "none",
      buttons: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const steps = 8;
    for (let index = 1; index <= steps; index += 1) {
      const x = fromX + ((toX - fromX) * index) / steps;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
      });
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async navigateHash(hash) {
    await this.eval(
      `(() => { location.hash = ${JSON.stringify(hash)}; return location.hash; })()`,
    );
  }

  async close() {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export async function connectMain(port) {
  const target = await waitForTarget(
    port,
    (entry) => entry.url.includes("localhost:1420/") && !entry.url.includes("recovery.html"),
    { timeout: 30_000 },
  );
  return CdpPage.connect(target, port);
}

export async function connectRecovery(port, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    for (const target of targets.filter(
      (entry) => entry.type === "page" && entry.url.includes("recovery.html"),
    )) {
      try {
        const page = await CdpPage.connect(target, port);
        // 旧恢复窗 target 可能短暂残留；必须确认页面真的响应后再使用。
        await page.eval("1 + 1", { timeout: 2500 });
        return page;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `恢复窗口不可响应${lastError ? `：${lastError.message}` : ""}`,
  );
}

export async function connectResponsiveMain(port, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    for (const target of targets.filter(
      (entry) =>
        entry.type === "page" &&
        entry.url.includes("localhost:1420/") &&
        !entry.url.includes("recovery.html"),
    )) {
      try {
        const page = await CdpPage.connect(target, port);
        // 冻结中的旧主窗口 target 仍在列表里，但不会响应 eval。
        await page.eval("1 + 1", { timeout: 2000 });
        return page;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `主窗口不可响应${lastError ? `：${lastError.message}` : ""}`,
  );
}

export async function firstTarget(port) {
  const target = await waitForTarget(port, () => true, { timeout: 30_000 });
  return CdpPage.connect(target, port);
}
