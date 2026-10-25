/**
 * Build-time version facts injected by Vite from the single source of truth
 * (`package.json`) and the current Git commit. Values are replaced at bundle
 * time by `vite.config.ts`; the fallbacks keep non-Vite tooling importable.
 */
const injectedVersion: unknown =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined;
const injectedCommit: unknown =
  typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : undefined;

export const APP_VERSION: string =
  typeof injectedVersion === "string" ? injectedVersion : "0.0.0-dev";
export const BUILD_COMMIT: string =
  typeof injectedCommit === "string" ? injectedCommit : "local";
