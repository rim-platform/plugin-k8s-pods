// Runs kubectl on this device with the user's own kubeconfig. Nothing here
// reads credentials itself or sends them anywhere: kubectl does the talking to
// the cluster, and the plugin only sees its JSON output and error text.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Why a kubectl call failed, as far as its error text tells. */
export type KubeErrorKind =
  | "kubectl_missing"
  | "no_kubeconfig"
  | "context_missing"
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "failed";

/** A kubectl call that failed, with its first error line as `detail`. */
export class KubeError extends Error {
  readonly kind: KubeErrorKind;
  readonly detail: string;

  constructor(kind: KubeErrorKind, detail: string) {
    super(detail);
    this.name = "KubeError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Runs kubectl with `args` and resolves with its stdout, or rejects with a {@link KubeError}. */
export type Kubectl = (args: readonly string[]) => Promise<string>;

/** How long one kubectl call may take before it counts as an unreachable cluster. */
const CALL_TIMEOUT_MS = 20_000;
/** What kubectl tells the API server to wait, shorter so its own error arrives first. */
export const REQUEST_TIMEOUT = "--request-timeout=15s";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DETAIL_LENGTH = 300;

/**
 * Where kubectl usually lives when an app started from the desktop gets a short
 * PATH (macOS apps launched from the Dock do not see the shell's PATH).
 */
function fallbackDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".rd", "bin"),
  ];
}

/**
 * The kubectl binary: `$RIM_KUBECTL` when set, else the first on PATH, else one
 * in a usual install folder, else plain `kubectl`.
 */
export function findKubectl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RIM_KUBECTL) return env.RIM_KUBECTL;
  const name = process.platform === "win32" ? "kubectl.exe" : "kubectl";
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbackDirs()];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

/** kubectl as installed on this device. */
export function systemKubectl(binary: string = findKubectl()): Kubectl {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        [...args],
        { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return reject(new KubeError("kubectl_missing", `${binary} was not found`));
          }
          if (error.killed || error.signal) {
            return reject(
              new KubeError(
                "unreachable",
                `kubectl did not answer within ${CALL_TIMEOUT_MS / 1000} seconds`,
              ),
            );
          }
          reject(classify(stderr || error.message));
        },
      );
    });
}

/** Turn kubectl's error text into a {@link KubeError}. */
export function classify(stderr: string): KubeError {
  const text = stderr.trim();
  const detail = firstErrorLine(text);
  const kind = ((): KubeErrorKind => {
    if (/\bforbidden\b/i.test(text)) return "forbidden";
    if (/unauthorized|must be logged in|provide credentials/i.test(text)) return "unauthorized";
    if (/context .*(does not exist|not found)|no context exists/i.test(text))
      return "context_missing";
    if (
      /no configuration has been provided|current-context is not set|invalid configuration/i.test(
        text,
      )
    )
      return "no_kubeconfig";
    if (
      /unable to connect to the server|connection refused|was refused|no such host|i\/o timeout|dial tcp|tls handshake timeout|context deadline exceeded|network is unreachable|connection reset|server is currently unable/i.test(
        text,
      )
    )
      return "unreachable";
    if (/\bnot ?found\b/i.test(text)) return "not_found";
    return "failed";
  })();
  return new KubeError(kind, detail);
}

function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const line =
    lines.find((l) => /^error/i.test(l)) ?? lines.find((l) => l.length > 0) ?? "kubectl failed";
  const clean = line.replace(/^error(:\s*)?/i, "").trim() || line;
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

/** The contexts in the user's kubeconfig, its current one and each context's namespace. */
export interface KubeConfig {
  readonly contexts: readonly string[];
  readonly current: string | null;
  readonly namespaces: Readonly<Record<string, string>>;
}

/**
 * Read context names from `kubectl config view`. kubectl redacts secrets from
 * this view, and only names and namespaces are kept.
 *
 * @throws KubeError `no_kubeconfig` when the kubeconfig has no contexts.
 */
export async function readConfig(kubectl: Kubectl): Promise<KubeConfig> {
  const raw = parseJson(await kubectl(["config", "view", "-o", "json"]));
  const contexts: string[] = [];
  const namespaces: Record<string, string> = {};
  for (const entry of asArray(raw.contexts)) {
    if (typeof entry.name !== "string" || entry.name.length === 0) continue;
    contexts.push(entry.name);
    const namespace = asRecord(entry.context).namespace;
    if (typeof namespace === "string" && namespace.length > 0) namespaces[entry.name] = namespace;
  }
  if (contexts.length === 0) {
    throw new KubeError("no_kubeconfig", "the kubeconfig has no contexts");
  }
  const current = raw["current-context"];
  return {
    contexts,
    current: typeof current === "string" && contexts.includes(current) ? current : null,
    namespaces,
  };
}

/** Namespace names, or `null` when the account may not list namespaces. */
export async function listNamespaces(kubectl: Kubectl, context: string): Promise<string[] | null> {
  try {
    const raw = parseJson(
      await kubectl(["get", "namespaces", "-o", "json", `--context=${context}`, REQUEST_TIMEOUT]),
    );
    return asArray(raw.items)
      .map((item) => asRecord(item.metadata).name)
      .filter((name): name is string => typeof name === "string")
      .sort();
  } catch (error) {
    if (error instanceof KubeError && error.kind === "forbidden") return null;
    throw error;
  }
}

/** The raw pod list of one namespace. */
export async function getPods(
  kubectl: Kubectl,
  context: string,
  namespace: string,
): Promise<unknown> {
  return parseJson(
    await kubectl([
      "get",
      "pods",
      "-o",
      "json",
      `--context=${context}`,
      `--namespace=${namespace}`,
      REQUEST_TIMEOUT,
    ]),
  );
}

/** One pod as kubectl returns it. */
export async function getPod(
  kubectl: Kubectl,
  context: string,
  namespace: string,
  pod: string,
): Promise<Record<string, unknown>> {
  return parseJson(
    await kubectl([
      "get",
      "pod",
      pod,
      "-o",
      "json",
      `--context=${context}`,
      `--namespace=${namespace}`,
      REQUEST_TIMEOUT,
    ]),
  );
}

/** Delete a pod without waiting for it to go, so its controller starts a new one. */
export async function deletePod(
  kubectl: Kubectl,
  context: string,
  namespace: string,
  pod: string,
): Promise<void> {
  await kubectl([
    "delete",
    "pod",
    pod,
    "--wait=false",
    `--context=${context}`,
    `--namespace=${namespace}`,
    REQUEST_TIMEOUT,
  ]);
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new KubeError("failed", "kubectl printed something that is not JSON");
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}
