// The Kubernetes pods plugin: lists the pods of one namespace in a panel,
// refreshes them on an interval and on demand, and restarts a pod after the
// user confirms. kubectl runs on this device with the user's kubeconfig, so
// cluster credentials never leave it.
//
// Outside this repository, import from "@rim/plugin-sdk" instead of the path below.
import {
  definePlugin,
  ErrorCode,
  HostRequestError,
  PluginError,
  type Host,
} from "../../sdk/plugin-sdk/src/index.ts";
import {
  deletePod,
  getPod,
  getPods,
  KubeError,
  listNamespaces,
  readConfig,
  systemKubectl,
  type KubeConfig,
  type KubeErrorKind,
  type Kubectl,
} from "./kubectl.ts";
import { controllerOf, summarizePods, type PodSummary } from "./pods.ts";

export const PLUGIN_ID = "chat.rim.k8s-pods";
export const PANEL_ID = "pods";

export const DEFAULT_INTERVAL_SECONDS = 15;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 3600;
/** Pods kept in the panel state; the host caps a plugin's panel state at 1 MiB. */
const MAX_PANEL_PODS = 2000;
/** Pods returned to the palette or the agent in one answer. */
const MAX_PAYLOAD_PODS = 500;
const MAX_FILTER_LENGTH = 100;

const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const POD_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** A failure the panel shows in place of the pod list. */
export interface PanelError {
  readonly kind: KubeErrorKind;
  readonly message: string;
  /** kubectl's own first error line, when there is one. */
  readonly detail?: string;
}

/** The outcome of the last restart, shown above the list. */
export interface LastAction {
  readonly pod: string;
  readonly namespace: string;
  readonly context: string;
  readonly ok: boolean;
  readonly message: string;
  readonly at: string;
}

/** Everything the panel renders. Sent whole with `host.panels.set` on each change. */
export interface PanelState {
  readonly contexts: readonly string[];
  readonly context: string | null;
  readonly namespace: string | null;
  /** Namespaces to pick from, or `null` when the account may not list them. */
  readonly namespaces: readonly string[] | null;
  readonly filter: string;
  readonly intervalSeconds: number;
  /** Pods matching `filter`, at most 2000. */
  readonly pods: readonly PodSummary[];
  /** Pods in the namespace before filtering. */
  readonly totalPods: number;
  readonly fetchedAt: string | null;
  readonly loading: boolean;
  readonly error: PanelError | null;
  readonly lastAction: LastAction | null;
}

/** Calls `run` every `ms` milliseconds until the returned function is called. */
export type Every = (ms: number, run: () => void) => () => void;

export interface K8sPodsOptions {
  /** Defaults to kubectl on this device. */
  readonly kubectl?: Kubectl;
  readonly now?: () => Date;
  /** Defaults to `setInterval`. */
  readonly every?: Every;
}

const defaultEvery: Every = (ms, run) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

/** A fresh plugin with its own selection and timer. */
export function createPlugin(options: K8sPodsOptions = {}) {
  const kubectl = options.kubectl ?? systemKubectl();
  const now = options.now ?? (() => new Date());
  const every = options.every ?? defaultEvery;

  let state: PanelState = {
    contexts: [],
    context: null,
    namespace: null,
    namespaces: null,
    filter: "",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    pods: [],
    totalPods: 0,
    fetchedAt: null,
    loading: false,
    error: null,
    lastAction: null,
  };
  let allPods: PodSummary[] = [];
  /** Namespaces per context, listed once per context. */
  const namespaceCache = new Map<string, string[] | null>();
  let host: Host | null = null;
  let panelDenied = false;
  let stopTimer: () => void = () => {};
  let inFlight: Promise<PanelState> | null = null;
  let queued: Promise<PanelState> | null = null;

  async function publish(patch: Partial<PanelState>): Promise<void> {
    state = { ...state, ...patch };
    if (!host || panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, state);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the pods panel stays empty: the ui.panel permission is not approved");
      } else {
        host.log.warn(`could not update the pods panel: ${(error as Error).message}`);
      }
    }
  }

  function visiblePods(filter: string): PodSummary[] {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? allPods.filter(
          (p) => p.name.toLowerCase().includes(needle) || p.status.toLowerCase().includes(needle),
        )
      : allPods;
    return matching.slice(0, MAX_PANEL_PODS);
  }

  /** Read the kubeconfig and make sure the selection names one of its contexts. */
  async function resolveSelection(): Promise<{
    config: KubeConfig;
    context: string;
    namespace: string;
  }> {
    const config = await readConfig(kubectl);
    const keep = state.context !== null && config.contexts.includes(state.context);
    const context = keep ? (state.context as string) : (config.current ?? config.contexts[0]);
    const namespace =
      keep && state.namespace ? state.namespace : (config.namespaces[context] ?? "default");
    return { config, context, namespace };
  }

  async function load(): Promise<PanelState> {
    await publish({ loading: true });
    let where: { context: string | null; namespace: string | null } = {
      context: state.context,
      namespace: state.namespace,
    };
    try {
      const { config, context, namespace } = await resolveSelection();
      where = { context, namespace };
      await publish({ contexts: config.contexts, context, namespace });
      if (!namespaceCache.has(context)) {
        namespaceCache.set(context, await listNamespaces(kubectl, context));
      }
      const list = await getPods(kubectl, context, namespace);
      // The user may have picked something else while kubectl ran.
      if (state.context !== context || state.namespace !== namespace) return state;
      allPods = summarizePods(list, now());
      await publish({
        namespaces: namespaceCache.get(context) ?? null,
        pods: visiblePods(state.filter),
        totalPods: allPods.length,
        fetchedAt: now().toISOString(),
        loading: false,
        error: null,
      });
    } catch (error) {
      allPods = [];
      await publish({
        pods: [],
        totalPods: 0,
        loading: false,
        error: describe(error, where.context, where.namespace),
      });
    }
    return state;
  }

  /**
   * List the pods again. A call while a listing runs waits for it and then lists
   * once more, so the answer reflects the newest selection; timer ticks skip.
   */
  function refresh(): Promise<PanelState> {
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    queued ??= inFlight.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }

  function startTimer(): void {
    stopTimer();
    stopTimer = () => {};
    if (state.intervalSeconds > 0) {
      stopTimer = every(state.intervalSeconds * 1000, () => {
        if (!inFlight) void refresh();
      });
    }
  }

  /** The answer of `refresh` and `filter`, or the panel's error as a command failure. */
  function listingResult(listed: PanelState) {
    if (listed.error) {
      throw new PluginError(listed.error.message, { data: { reason: listed.error.kind } });
    }
    const pods = listed.pods.slice(0, MAX_PAYLOAD_PODS).map((p) => ({
      name: p.name,
      status: p.status,
      ready: p.ready,
      restarts: p.restarts,
      age: p.age,
      node: p.node,
    }));
    const shown =
      listed.filter && listed.pods.length !== listed.totalPods
        ? `${listed.pods.length} of ${listed.totalPods} pods match "${listed.filter}"`
        : `${listed.totalPods} pod${listed.totalPods === 1 ? "" : "s"}`;
    return {
      payload: {
        context: listed.context ?? "",
        namespace: listed.namespace ?? "",
        totalPods: listed.totalPods,
        pods,
      },
      message: `${shown} in ${listed.namespace} (${listed.context})`,
    };
  }

  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      refresh: {
        async run() {
          return listingResult(await refresh());
        },
      },
      filter: {
        async run({ args }) {
          const text = optionalString(args.text, "text", MAX_FILTER_LENGTH);
          const namespace = optionalString(args.namespace, "namespace", 63);
          const context = optionalString(args.context, "context", 253);
          const interval = optionalInterval(args.interval_seconds);
          if (namespace !== undefined && !NAMESPACE.test(namespace)) {
            throw invalid(`"${namespace}" is not a namespace name`);
          }
          if (context !== undefined) {
            const config = await readConfig(kubectl).catch((error: unknown) => {
              throw toPluginError(error, null, null);
            });
            if (!config.contexts.includes(context)) {
              throw invalid(`context "${context}" is not in your kubeconfig`);
            }
          }

          const nothingGiven =
            text === undefined &&
            namespace === undefined &&
            context === undefined &&
            interval === undefined;
          const contextChanged = context !== undefined && context !== state.context;
          const patch: { -readonly [K in keyof PanelState]?: PanelState[K] } = {};
          if (text !== undefined || nothingGiven) patch.filter = (text ?? "").trim();
          if (context !== undefined) patch.context = context;
          if (namespace !== undefined) patch.namespace = namespace;
          else if (contextChanged) patch.namespace = null; // the context's own default
          if (interval !== undefined) patch.intervalSeconds = interval;
          if (patch.filter !== undefined) patch.pods = visiblePods(patch.filter);
          await publish(patch);
          if (interval !== undefined) startTimer();
          return listingResult(await refresh());
        },
      },
      restart_pod: {
        dangerous: true,
        async run({ args }) {
          const pod = requiredName(args.pod);
          const namespaceArg = optionalString(args.namespace, "namespace", 63);
          const contextArg = optionalString(args.context, "context", 253);
          if (namespaceArg !== undefined && !NAMESPACE.test(namespaceArg)) {
            throw invalid(`"${namespaceArg}" is not a namespace name`);
          }

          let context = contextArg ?? state.context;
          let namespace = namespaceArg ?? null;
          try {
            const config = await readConfig(kubectl);
            context ??= config.current ?? config.contexts[0];
            if (!config.contexts.includes(context)) {
              throw invalid(`context "${context}" is not in your kubeconfig`);
            }
            namespace ??=
              (context === state.context ? state.namespace : null) ??
              config.namespaces[context] ??
              "default";

            const controller = controllerOf(await getPod(kubectl, context, namespace, pod));
            if (!controller) {
              throw new PluginError(
                `${pod} has no controller to start it again, so restarting it would delete it for good. ` +
                  "Only pods managed by a Deployment, StatefulSet, DaemonSet, ReplicaSet or Job can be restarted here.",
                { data: { reason: "no_controller" } },
              );
            }
            if (controller.startsWith("Node/")) {
              throw new PluginError(
                `${pod} is a static pod: the kubelet on its node runs it from a file, so deleting it here restarts nothing. ` +
                  "Restart it on the node instead.",
                { data: { reason: "static_pod" } },
              );
            }
            await deletePod(kubectl, context, namespace, pod);
            const message = `Restarted ${pod} in ${namespace}: ${controller} starts a new pod.`;
            await publish({ lastAction: action(pod, namespace, context, true, message) });
            void refresh();
            return { payload: { pod, namespace, context, controller }, message };
          } catch (error) {
            const failure =
              error instanceof PluginError ? error : toPluginError(error, context, namespace);
            await publish({
              lastAction: action(
                pod,
                namespace ?? "",
                context ?? "",
                false,
                `Could not restart ${pod}: ${failure.message}`,
              ),
            });
            throw failure;
          }
        },
      },
    },
    async onReady(ready) {
      host = ready;
      host.log.info("listing pods with kubectl on this device; credentials stay local");
      startTimer();
      await refresh();
    },
    onShutdown() {
      stopTimer();
      host = null;
    },
  });

  function action(
    pod: string,
    namespace: string,
    context: string,
    ok: boolean,
    message: string,
  ): LastAction {
    return { pod, namespace, context, ok, message, at: now().toISOString() };
  }
}

/** What the panel and the user see for a failed kubectl call. */
export function describe(
  error: unknown,
  context: string | null,
  namespace: string | null,
): PanelError {
  if (!(error instanceof KubeError)) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const ctx = context ? `"${context}"` : "the current context";
  const ns = namespace ? `"${namespace}"` : "this namespace";
  const message = ((): string => {
    switch (error.kind) {
      case "kubectl_missing":
        return "kubectl was not found on this device. Install kubectl and restart RIM, so the plugin can find it on your PATH.";
      case "no_kubeconfig":
        return "No kubeconfig found. The plugin reads the same file kubectl does: $KUBECONFIG, or ~/.kube/config.";
      case "context_missing":
        return `The context ${ctx} is not in your kubeconfig. Pick another context.`;
      case "unreachable":
        return `Cannot reach the cluster of ${ctx}. Check your network or VPN, and that the cluster is running.`;
      case "unauthorized":
        return `The cluster of ${ctx} did not accept your credentials. Sign in again with your cluster's tools, then refresh.`;
      case "forbidden":
        return `Your account may not do this in the namespace ${ns} on ${ctx}. Pick another namespace or ask a cluster admin for access.`;
      case "not_found":
        return `Not found in the namespace ${ns}: ${error.detail}`;
      case "failed":
        return `kubectl failed: ${error.detail}`;
    }
  })();
  return { kind: error.kind, message, detail: error.detail };
}

function toPluginError(
  error: unknown,
  context: string | null,
  namespace: string | null,
): PluginError {
  if (error instanceof PluginError) return error;
  const described = describe(error, context, namespace);
  return new PluginError(described.message, { data: { reason: described.kind } });
}

function invalid(message: string): PluginError {
  return new PluginError(message, { code: ErrorCode.INVALID_PARAMS });
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  if (value.length > maxLength) throw invalid(`${name} is longer than ${maxLength} characters`);
  return value;
}

function requiredName(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    throw invalid("pod is required: use the Restart button next to a pod in the Pods panel");
  }
  if (typeof value !== "string" || !POD_NAME.test(value)) {
    throw invalid(`"${String(value)}" is not a pod name`);
  }
  return value;
}

function optionalInterval(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = typeof value === "string" ? Number(value) : value;
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    (seconds !== 0 && (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS))
  ) {
    throw invalid(
      `interval_seconds must be 0 or a whole number from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`,
    );
  }
  return seconds;
}
