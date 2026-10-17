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
  const columns = podColumns(pod);
  const created = typeof metadata.creationTimestamp === "string" ? metadata.creationTimestamp : "";
  const createdAt = created && !Number.isNaN(Date.parse(created)) ? created : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name : "(unnamed)",
    status: columns.status,
    ready: `${columns.readyCount}/${columns.containerCount}`,
    restarts: columns.restarts,
    age: createdAt ? formatAge(new Date(createdAt), now) : "",
    createdAt,
    node: typeof spec.nodeName === "string" ? spec.nodeName : "",
    controller: controllerOf(pod),
  };
}

/** STATUS as `kubectl get pods` computes it. */
export function podStatus(pod: Record<string, unknown>): string {
  return podColumns(pod).status;
}

interface PodColumns {
  readonly status: string;
  readonly readyCount: number;
  readonly containerCount: number;
  readonly restarts: number;
}

/**
 * STATUS, READY and RESTARTS as `kubectl get pods` computes them. Sidecars (init
 * containers with `restartPolicy: Always`) count as containers, and a started
 * sidecar no longer holds the pod in initialization.
 */
function podColumns(pod: Record<string, unknown>): PodColumns {
  const metadata = asRecord(pod.metadata);
  const spec = asRecord(pod.spec);
  const status = asRecord(pod.status);
  const conditions = asArray(status.conditions);
  let reason = text(status.reason) || text(status.phase) || "Unknown";
  if (conditions.some((c) => c.type === "PodScheduled" && c.reason === "SchedulingGated")) {
    reason = "SchedulingGated";
  }

  const initSpecs = asArray(spec.initContainers);
  const sidecars = new Set(
    initSpecs.filter((c) => c.restartPolicy === "Always").map((c) => text(c.name)),
  );
  const inits = asArray(status.initContainerStatuses);
  const initCount = Math.max(initSpecs.length, inits.length);
  const containerCount =
    Math.max(asArray(spec.containers).length, asArray(status.containerStatuses).length) +
    sidecars.size;

  let readyCount = 0;
  let restarts = 0;
  let sidecarRestarts = 0;
  let initializing = false;
  for (const [index, init] of inits.entries()) {
    const sidecar = sidecars.has(text(init.name));
    restarts += restartCount(init);
    if (sidecar) sidecarRestarts += restartCount(init);
    const state = asRecord(init.state);
    const terminated = asRecord(state.terminated);
    const waiting = asRecord(state.waiting);
    if (state.terminated !== undefined && terminated.exitCode === 0) continue;
    if (sidecar && init.started === true) {
      if (init.ready === true) readyCount++;
      continue;
    }
    initializing = true;
    if (state.terminated !== undefined) {
      reason = `Init:${text(terminated.reason) || exitText(terminated)}`;
    } else if (text(waiting.reason) && waiting.reason !== "PodInitializing") {
      reason = `Init:${text(waiting.reason)}`;
    } else {
      reason = `Init:${index}/${initCount}`;
    }
    break;
  }

  const initialized = conditions.some((c) => c.type === "Initialized" && c.status === "True");
  if (!initializing || initialized) {
    restarts = sidecarRestarts;
    let running = false;
    for (const container of asArray(status.containerStatuses).reverse()) {
      restarts += restartCount(container);
      const state = asRecord(container.state);
      const waiting = asRecord(state.waiting);
      const terminated = asRecord(state.terminated);
      if (text(waiting.reason)) {
        reason = text(waiting.reason);
      } else if (state.terminated !== undefined) {
        reason = text(terminated.reason) || exitText(terminated);
      } else if (state.running !== undefined && container.ready === true) {
        running = true;
        readyCount++;
      }
    }
    if (reason === "Completed" && running) {
      const ready = conditions.some((c) => c.type === "Ready" && c.status === "True");
      reason = ready ? "Running" : "NotReady";
    }
  }

  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    if (status.reason === "NodeLost") {
      reason = "Unknown";
    } else if (status.phase !== "Succeeded" && status.phase !== "Failed") {
      reason = "Terminating";
    }
  }
  return { status: reason, readyCount, containerCount, restarts };
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

function restartCount(status: Record<string, unknown>): number {
  return typeof status.restartCount === "number" ? status.restartCount : 0;
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
