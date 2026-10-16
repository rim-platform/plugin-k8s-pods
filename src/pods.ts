// Turns kubectl's pod JSON into the rows the panel shows, the way `kubectl get
// pods` prints them: status, ready containers, restarts and age.
import { asArray, asRecord } from "./kubectl.ts";

/** One pod as the panel and the agent see it. */
export interface PodSummary {
  readonly name: string;
  /** What `kubectl get pods` shows in STATUS, e.g. `Running` or `CrashLoopBackOff`. */
  readonly status: string;
  /** Ready containers out of all, e.g. `1/2`. */
  readonly ready: string;
  readonly restarts: number;
  /** Short age as kubectl prints it, e.g. `5m` or `3d`, at the time of the listing. */
  readonly age: string;
  /** Creation time as ISO 8601, so the panel can keep the age current. */
  readonly createdAt: string | null;
  readonly node: string;
  /** The controller that recreates the pod (`ReplicaSet/web-7f9c`), or `null`. */
  readonly controller: string | null;
}

/** Rows for every pod in a `kubectl get pods -o json` list, sorted by name. */
export function summarizePods(list: unknown, now: Date): PodSummary[] {
  return asArray(asRecord(list).items)
    .map((pod) => summarizePod(pod, now))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizePod(pod: Record<string, unknown>, now: Date): PodSummary {
  const metadata = asRecord(pod.metadata);
  const spec = asRecord(pod.spec);
  const statuses = asArray(asRecord(pod.status).containerStatuses);
  const containerCount = Math.max(asArray(spec.containers).length, statuses.length);
  const readyCount = statuses.filter((s) => s.ready === true).length;
  const restarts = statuses.reduce(
    (sum, s) => sum + (typeof s.restartCount === "number" ? s.restartCount : 0),
    0,
  );
  const created = typeof metadata.creationTimestamp === "string" ? metadata.creationTimestamp : "";
  const createdAt = created && !Number.isNaN(Date.parse(created)) ? created : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name : "(unnamed)",
    status: podStatus(pod),
    ready: `${readyCount}/${containerCount}`,
    restarts,
    age: createdAt ? formatAge(new Date(createdAt), now) : "",
    createdAt,
    node: typeof spec.nodeName === "string" ? spec.nodeName : "",
    controller: controllerOf(pod),
  };
}

/** STATUS as `kubectl get pods` computes it. */
export function podStatus(pod: Record<string, unknown>): string {
  const metadata = asRecord(pod.metadata);
  const status = asRecord(pod.status);
  let reason = text(status.reason) || text(status.phase) || "Unknown";

  const inits = asArray(status.initContainerStatuses);
  let initializing = false;
  for (const [index, init] of inits.entries()) {
    const state = asRecord(init.state);
    const terminated = asRecord(state.terminated);
    const waiting = asRecord(state.waiting);
    if (state.terminated !== undefined && terminated.exitCode === 0) continue;
    initializing = true;
    if (state.terminated !== undefined) {
      reason = `Init:${text(terminated.reason) || exitText(terminated)}`;
    } else if (text(waiting.reason) && waiting.reason !== "PodInitializing") {
      reason = `Init:${text(waiting.reason)}`;
    } else {
      reason = `Init:${index}/${inits.length}`;
    }
    break;
  }

  if (!initializing) {
    let running = false;
    for (const container of asArray(status.containerStatuses).reverse()) {
      const state = asRecord(container.state);
      const waiting = asRecord(state.waiting);
      const terminated = asRecord(state.terminated);
      if (text(waiting.reason)) {
        reason = text(waiting.reason);
      } else if (state.terminated !== undefined) {
        reason = text(terminated.reason) || exitText(terminated);
      } else if (state.running !== undefined && container.ready === true) {
        running = true;
      }
    }
    if (reason === "Completed" && running) reason = "Running";
  }

  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    reason = status.reason === "NodeLost" ? "Unknown" : "Terminating";
  }
  return reason;
}

/** `ReplicaSet/web-7f9c` for the owner that recreates the pod, or `null` for a bare pod. */
export function controllerOf(pod: Record<string, unknown>): string | null {
  const owner = asArray(asRecord(pod.metadata).ownerReferences).find((o) => o.controller === true);
  if (!owner || typeof owner.kind !== "string" || typeof owner.name !== "string") return null;
  return `${owner.kind}/${owner.name}`;
}

/** Age the way kubectl prints it: `45s`, `12m`, `3h`, `5d`, `2y`. */
export function formatAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 730) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function exitText(terminated: Record<string, unknown>): string {
  if (typeof terminated.signal === "number" && terminated.signal !== 0) {
    return `Signal:${terminated.signal}`;
  }
  return `ExitCode:${typeof terminated.exitCode === "number" ? terminated.exitCode : "?"}`;
}
