// The plugin's settings, as `settings_schema` in rim-plugin.json declares them
// and the host hands them over. Each value is checked on its own: one that does
// not fit, e.g. saved under an older schema, counts as unset.
import { homedir } from "node:os";
import { join } from "node:path";

import { MAX_LOG_LINES } from "./logs.ts";

export const DEFAULT_INTERVAL_SECONDS = 15;
export const MIN_INTERVAL_SECONDS = 5;
export const MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_LOG_LINES = 100;

/** A Kubernetes namespace name. */
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const MAX_PATH_LENGTH = 4096;
const MAX_CONTEXT_LENGTH = 253;

/** The settings in use; `null` for one the user left empty. */
export interface PluginSettings {
  /** The kubeconfig file, passed to kubectl as `--kubeconfig`. */
  readonly kubeconfig: string | null;
  /** The kubectl binary; `null` finds it on this device. */
  readonly kubectlPath: string | null;
  /** The context to show when none is picked. */
  readonly defaultContext: string | null;
  /** The namespace to show when none is picked. */
  readonly defaultNamespace: string | null;
  readonly intervalSeconds: number;
  readonly logTailLines: number;
}

/** The settings while the user has saved none, and on a host without settings. */
export const DEFAULT_SETTINGS: PluginSettings = {
  kubeconfig: null,
  kubectlPath: null,
  defaultContext: null,
  defaultNamespace: null,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  logTailLines: DEFAULT_LOG_LINES,
};

/** The settings in `values`, and the keys whose values did not fit and were left unset. */
export function parseSettings(values: Readonly<Record<string, unknown>>): {
  settings: PluginSettings;
  ignored: string[];
} {
  const ignored: string[] = [];
  /** `check`'s answer for the value of `key`, or `null` when it is empty or does not fit. */
  const read = <T>(key: string, check: (value: unknown) => T | null): T | null => {
    const value = values[key];
    // Blank text is the same as an empty field.
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      return null;
    }
    const checked = check(value);
    if (checked === null) ignored.push(key);
    return checked;
  };
  const settings: PluginSettings = {
    kubeconfig: read("kubeconfig", path),
    kubectlPath: read("kubectl_path", path),
    defaultContext: read("default_context", (value) => text(value, MAX_CONTEXT_LENGTH)),
    defaultNamespace: read("default_namespace", (value) => {
      const namespace = text(value, 63);
      return namespace !== null && NAMESPACE.test(namespace) ? namespace : null;
    }),
    intervalSeconds:
      read("refresh_interval_seconds", (value) =>
        integer(value, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
      ) ?? DEFAULT_INTERVAL_SECONDS,
    logTailLines:
      read("log_tail_lines", (value) => integer(value, 1, MAX_LOG_LINES)) ?? DEFAULT_LOG_LINES,
  };
  return { settings, ignored };
}

/** The kubectl flags every call gets from the settings. */
export function kubectlFlags(settings: PluginSettings): string[] {
  return settings.kubeconfig === null ? [] : [`--kubeconfig=${settings.kubeconfig}`];
}

/** `~` or a leading `~/` as the home folder; other paths as they are. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (/^~[/\\]/.test(path)) return join(homedir(), path.slice(2));
  return path;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function path(value: unknown): string | null {
  const trimmed = text(value, MAX_PATH_LENGTH);
  return trimmed === null || trimmed.includes("\0") ? null : expandHome(trimmed);
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}
