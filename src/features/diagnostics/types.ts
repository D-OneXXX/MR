export interface DiagnosticRuntime {
  version: string;
  buildBaseline: string;
  /** 构建来源指纹：official / community（区分官方发行版与社区魔改版）。 */
  buildOrigin: string;
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
