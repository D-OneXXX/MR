export interface DiagnosticRuntime {
  version: string;
  buildBaseline: string;
  os: string;
  arch: string;
  route?: string | null;
  readerMode?: string | null;
  readerPage?: number | null;
  networkMode: string;
  proxyScheme?: string | null;
  onlineEnabled: boolean;
  safeMode: boolean;
}

export interface DiagnosticBreadcrumb {
  at: string;
  kind: string;
  route?: string | null;
}

export interface DiagnosticError {
  at: string;
  source: string;
  message: string;
  stack?: string | null;
  route?: string | null;
}

export interface DiagnosticLog {
  at: string;
  scope: string;
  message: string;
}

export interface DiagnosticBundle {
  generatedAt: string;
  runtime: DiagnosticRuntime;
  breadcrumbs: DiagnosticBreadcrumb[];
  errors: DiagnosticError[];
  logs: DiagnosticLog[];
}
