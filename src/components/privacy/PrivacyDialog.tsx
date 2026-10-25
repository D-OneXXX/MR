import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Database,
  ShieldCheck,
  Wifi,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { useUpdater } from "@/features/update/UpdateProvider";

export const PRIVACY_DIALOG_EVENT = "mr-privacy-open";
export const PRIVACY_POLICY_VERSION = "2026-10";
const ACK_KEY = "mr-privacy-ack";

function majorOf(version: string): string {
  return version.split(".")[0] || "0";
}

function ackToken(version: string): string {
  return `${PRIVACY_POLICY_VERSION}:${majorOf(version)}`;
}

function readAck(): string | null {
  try {
    return localStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
}

function writeAck(token: string) {
  try {
    localStorage.setItem(ACK_KEY, token);
  } catch {
    /* Acknowledgement is best effort. */
  }
}

/**
 * First-run (and per-major-version) data-boundary statement. It never blocks
 * local reading: dismissing it just postpones acknowledgement to next launch.
 */
export default function PrivacyDialog() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { appInfo } = useUpdater();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");

  const evaluate = useCallback((version: string) => {
    const next = ackToken(version);
    setToken(next);
    if (readAck() !== next) setOpen(true);
  }, []);

  useEffect(() => {
    if (appInfo) {
      evaluate(appInfo.version);
      return;
    }
    const timer = window.setTimeout(() => evaluate("0.0.0"), 2500);
    return () => window.clearTimeout(timer);
  }, [appInfo, evaluate]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(PRIVACY_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(PRIVACY_DIALOG_EVENT, onOpen);
  }, []);

  const acknowledge = () => {
    if (token) writeAck(token);
    setOpen(false);
  };

  const openSettings = () => {
    acknowledge();
    nav("/settings?tab=privacy");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] gap-0 overflow-y-auto rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-[560px]"
        aria-describedby="privacy-dialog-description"
      >
        <DialogHeader className="gap-2 border-b border-border/70 px-6 pb-4 pt-6">
          <span className="grid size-11 place-items-center rounded-2xl border border-border bg-primary text-primary-foreground shadow-hard-sm">
            <ShieldCheck className="size-5" />
          </span>
          <DialogTitle className="text-xl font-extrabold tracking-tight">
            {t("privacy.dialog.title")}
          </DialogTitle>
          <DialogDescription
            id="privacy-dialog-description"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            {t("privacy.dialog.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6 py-5">
          <div className="flex gap-3 rounded-2xl border border-border bg-background/60 p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-success/10 text-success">
              <Database className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {t("privacy.dialog.localTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("privacy.dialog.localBody")}
              </p>
            </div>
          </div>
          <div className="flex gap-3 rounded-2xl border border-border bg-background/60 p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground">
              <Wifi className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {t("privacy.dialog.networkTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("privacy.dialog.networkBody")}
              </p>
            </div>
          </div>
          <p className="rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs font-medium leading-relaxed text-foreground">
            {t("privacy.dialog.noTelemetry")}
          </p>
        </div>

        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 rounded-b-2xl border-t border-border bg-muted/40 px-6 py-4">
          <span className="font-mono text-[10px] text-muted-foreground">
            {t("privacy.dialog.policyVersion", {
              version: PRIVACY_POLICY_VERSION,
            })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              onClick={openSettings}
            >
              {t("privacy.dialog.openSettings")}
              <ArrowRight />
            </Button>
            <Button
              type="button"
              variant="pill-primary"
              size="pill-sm"
              onClick={acknowledge}
            >
              {t("privacy.dialog.ack")}
            </Button>
          </div>
        </DialogFooter>
        <button
          type="button"
          aria-label={t("privacy.dialog.close")}
          className="absolute right-3 top-3 grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          onClick={() => setOpen(false)}
        >
          <X className="size-4" />
        </button>
      </DialogContent>
    </Dialog>
  );
}
