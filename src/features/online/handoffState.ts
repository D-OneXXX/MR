import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type BookInfo, type HandoffStatus } from "@/lib/tauri";
import { translate } from "@/i18n";
import { toast } from "@/components/Toast";
import { recordBreadcrumb } from "@/features/resilience";

const HANDOFF_STATE_EVENT = "mr-online-handoff-state";

export interface OnlineHandoffState {
  status: HandoffStatus | null;
}

let handoffStatus: HandoffStatus | null = null;
let handoffListenersStarted = false;
let statusRequestSeq = 0;
let unlistenImported: (() => void) | undefined;
let unlistenStopped: (() => void) | undefined;

function getHandoffState(): OnlineHandoffState {
  return { status: handoffStatus };
}

function notifyHandoffState() {
  window.dispatchEvent(new CustomEvent(HANDOFF_STATE_EVENT));
}

function applyHandoffStatus(status: HandoffStatus) {
  statusRequestSeq += 1;
  handoffStatus = status.active ? status : null;
  notifyHandoffState();
}

async function refreshHandoffStatus() {
  const seq = ++statusRequestSeq;
  try {
    const status = await api.getBrowserHandoffStatus();
    if (seq !== statusRequestSeq) return;
    handoffStatus = status.active ? status : null;
    notifyHandoffState();
  } catch {
    /* 契约未落盘或后端不可用时保持当前状态 */
  }
}

function clearHandoffStatus(showToast: boolean) {
  statusRequestSeq += 1;
  const wasActive = handoffStatus?.active ?? false;
  handoffStatus = null;
  notifyHandoffState();
  if (showToast && wasActive) toast(translate("pair.toastStopped"));
}

export function useOnlineHandoffState(): OnlineHandoffState {
  const [state, setState] = useState<OnlineHandoffState>(getHandoffState);
  useEffect(() => {
    const onChange = () => setState(getHandoffState());
    window.addEventListener(HANDOFF_STATE_EVENT, onChange);
    void refreshHandoffStatus();
    return () => window.removeEventListener(HANDOFF_STATE_EVENT, onChange);
  }, []);
  return state;
}

/** 启动辅助验证交接（本地回环桥）；会话请求头只驻留内存。 */
export async function startBrowserHandoffSession(
  allowSessionHeaders: boolean,
): Promise<void> {
  const next = await api.startBrowserHandoff(allowSessionHeaders);
  recordBreadcrumb("onlinePairing");
  applyHandoffStatus(next);
}

/** 停止辅助验证交接并清空内存中的会话请求头。 */
export async function stopBrowserHandoffSession(): Promise<void> {
  await api.stopBrowserHandoff();
  clearHandoffStatus(true);
}

/** 手动刷新交接状态（交接卡片刷新按钮）。 */
export async function refreshBrowserHandoffSession(): Promise<void> {
  await refreshHandoffStatus();
}

function registerHandoffListener<T>(
  event: string,
  handler: (payload: T) => void,
  remember: (off: () => void) => void,
) {
  try {
    void listen<T>(event, (e) => handler(e.payload))
      .then((off) => {
        if (handoffListenersStarted) remember(off);
        else off();
      })
      .catch(() => {});
  } catch {
    /* 非 Tauri 环境 */
  }
}

function registerHandoffListeners() {
  if (handoffListenersStarted) return;
  handoffListenersStarted = true;

  registerHandoffListener<BookInfo[]>(
    "online-handoff-imported",
    (payload) => {
      const raw = payload as unknown;
      const imported = Array.isArray(raw)
        ? (raw as BookInfo[])
        : raw
          ? [raw as BookInfo]
          : [];
      if (imported.length > 0 && handoffStatus?.active) {
        handoffStatus = {
          ...handoffStatus,
          receivedChapters: handoffStatus.receivedChapters + imported.length,
        };
        notifyHandoffState();
      }
      void refreshHandoffStatus();
      // Toast、书库刷新与角标由 Shell 的全局监听负责，避免重复提示。
    },
    (off) => {
      unlistenImported = off;
    },
  );

  registerHandoffListener<void>(
    "online-handoff-stopped",
    () => {
      clearHandoffStatus(true);
    },
    (off) => {
      unlistenStopped = off;
    },
  );
}

registerHandoffListeners();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unlistenImported?.();
    unlistenStopped?.();
    unlistenImported = undefined;
    unlistenStopped = undefined;
    handoffListenersStarted = false;
  });
}
