import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { translate, useI18n } from "@/i18n";
import { api, type OpenWithRequest } from "@/lib/tauri";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";
import { toast } from "@/components/Toast";
import {
  LIBRARY_REFRESH_EVENT,
  OPEN_WITH_PENDING_EVENT,
} from "@/lib/events";

function baseName(path: string | undefined): string {
  if (!path) return translate("common.unknown");
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 单实例 / 文件关联 / 命令行直开桥。
 *
 * 后端只发送无载荷 ping；真正的请求通过 `take_pending_open` 一次性消费，
 * 因此「事件先到、组件后挂载」或重复 ping 都不会重复打开同一本书。
 * 安全模式开启时不挂载 Reader，只把书导入书库并回到书库页。
 */
export default function OpenWithBridge() {
  const nav = useNavigate();
  const { t } = useI18n();
  const { active: safeModeActive } = useSafeMode();
  const draining = useRef(false);
  const pingAgain = useRef(false);
  const safeModeRef = useRef(safeModeActive);
  safeModeRef.current = safeModeActive;

  const handle = (request: OpenWithRequest) => {
    window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
    recordBreadcrumb("fileOpen");

    if (!request.book) {
      toast(
        t("openWith.failed", {
          name: baseName(request.paths[0]),
        }),
      );
      return;
    }
    if (safeModeRef.current) {
      toast(t("openWith.safeMode"));
      nav("/");
      return;
    }
    nav(`/reader/${encodeURIComponent(request.book.id)}`);
  };

  const drain = async () => {
    if (draining.current) {
      pingAgain.current = true;
      return;
    }
    draining.current = true;
    try {
      // FIFO：极端情况下同一次启动可能带多个路径，逐条消费直到空。
      for (let i = 0; i < 16; i += 1) {
        const request = await api.takePendingOpen();
        if (!request) break;
        handle(request);
      }
    } catch {
      // 非 Tauri 环境/命令不可用：静默，启动桥绝不拖垮 UI。
      // 错误内容可能含本地路径，不写日志。
    } finally {
      draining.current = false;
      if (pingAgain.current) {
        // 事件恰好在“取到 null”与“释放 draining”之间到达：再排一轮。
        pingAgain.current = false;
        void drain();
      }
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void drain();
    listen<void>(OPEN_WITH_PENDING_EVENT, () => {
      pingAgain.current = true;
      void drain();
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 非 Tauri 环境忽略 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // handle 依赖 t/nav/安全模式；依赖变化时重新挂载监听即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, t, safeModeActive]);

  return null;
}
