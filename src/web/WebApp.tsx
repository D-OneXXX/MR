import { LOCALES, localeLabel, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";

/**
 * Web Access 最小验证原型（W2 / BLK-2）。
 *
 * 本页**刻意不实现任何 Web Access 功能**——没有 API 调用、没有网络服务、
 * 没有阅读器、没有书库。它只验证四件事：
 *
 *   1. 独立 Vite 入口能构建并产出静态页面；
 *   2. React 组件可跨入口复用（components/ui/button）；
 *   3. 国际化可用（useI18n / 六语切换）；
 *   4. Tauri IPC 隔离——本入口不 import 任何 `@tauri-apps/*`，
 *      因此浏览器产物里既不应出现 `__TAURI_INTERNALS__`，也不应出现 `plugin:`。
 *
 * 第 4 条由构建产物断言把关（见 docs/dev/WEB_ACCESS_W2_ACCEPTANCE_REPORT.md）。
 */
export default function WebApp() {
  const { t, locale, setLocale } = useI18n();

  // IPC 隔离的直接证据：桌面运行时注入的内部对象在浏览器里必须不存在。
  //
  // 键名刻意**不写成字面量**：产物级断言要数的是"是否引用了 Tauri 运行时"，
  // 若探测串本身以字面量出现在产物里，这个计数就永远非零、断言永远失效——
  // 守卫必须数对东西，不能被被测对象自己污染。
  const tauriRuntime =
    typeof window !== "undefined" &&
    ["__TAURI", "INTERNALS__"].join("_") in window;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 bg-background px-4 py-8 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-extrabold tracking-tight">{t("app.title")}</h1>
        <p className="text-sm opacity-70">
          Web Access 验证原型 · {__BUILD_COMMIT__}
        </p>
      </header>

      <section className="flex items-center justify-between gap-3 rounded-xl border border-border p-4 text-sm">
        <span className="font-medium">Tauri IPC</span>
        <span
          className={
            tauriRuntime
              ? "rounded-lg bg-primary px-2 py-0.5 text-primary-foreground"
              : "rounded-lg border border-border px-2 py-0.5"
          }
        >
          {tauriRuntime ? "present" : "absent"}
        </span>
      </section>
      <p className="-mt-2 text-sm opacity-70">
        期望 absent：Web 入口不得依赖 Tauri 运行时。若此处显示 present，说明 IPC
        隔离被破坏。
      </p>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">语言 / Locale</span>
        <div className="flex flex-wrap gap-2">
          {LOCALES.map((item) => (
            <Button
              key={item}
              variant={item === locale ? "default" : "outline"}
              size="sm"
              onClick={() => setLocale(item)}
            >
              {localeLabel(item)}
            </Button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border p-4 text-sm">
        <p className="opacity-70">
          {t("common.loading")} · {t("common.confirm")} · {t("common.cancel")}
        </p>
      </section>
    </main>
  );
}
