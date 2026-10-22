import {
  Component,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import DiagnosticPanel from "@/components/diagnostics/DiagnosticPanel";
import { useI18n } from "@/i18n";
import { recordBoundaryError } from "@/features/resilience/errors";

interface BoundaryState {
  failed: boolean;
  message: string;
}

function FatalFallback({
  onRetry,
  message,
}: {
  onRetry: () => void;
  message: string;
}) {
  const { t } = useI18n();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  return (
    <div className="h-screen w-full overflow-y-auto bg-background px-5 py-8 text-foreground sm:px-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <Card className="gap-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-border bg-destructive/10 text-destructive shadow-hard-sm">
              <AlertTriangle className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-extrabold tracking-tight">
                {t("errorBoundary.title")}
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t("errorBoundary.description")}
              </p>
            </div>
            <Badge variant="success" className="gap-1.5">
              <ShieldCheck className="size-3.5" aria-hidden />
              {t("errorBoundary.localOnly")}
            </Badge>
          </div>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-secondary/60 p-3 font-mono text-[11px]">
            {message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="pill-primary" size="pill" onClick={onRetry}>
              <RotateCcw />
              {t("errorBoundary.retry")}
            </Button>
            <Button
              variant="pill"
              size="pill"
              onClick={() => window.location.reload()}
            >
              <RefreshCw />
              {t("errorBoundary.reload")}
            </Button>
            <Button
              variant="pill"
              size="pill"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((value) => !value)}
            >
              <Sparkles />
              {diagnosticsOpen
                ? t("errorBoundary.hideDiagnostics")
                : t("errorBoundary.generate")}
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            <BookOpenCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("errorBoundary.note")}
          </p>
        </Card>
        {diagnosticsOpen ? (
          <Card className="p-5 sm:p-6">
            <DiagnosticPanel />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** Catches render/effect failures and offers local diagnostics, never auto-reload. */
export default class AppErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordBoundaryError(error, info.componentStack ?? undefined);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <FatalFallback
          message={this.state.message}
          onRetry={() => this.setState({ failed: false, message: "" })}
        />
      );
    }
    return this.props.children;
  }
}
