// The Kubernetes pods plugin: lists the pods of one namespace in a panel,
// refreshes them on an interval and on demand, shows and follows a container's
// logs, and restarts a pod after the user confirms. kubectl runs on this device
// with the user's kubeconfig, so cluster credentials never leave it.

import {
  definePlugin,
  ErrorCode,
  HostRequestError,
  PluginError,
  type Host,
} from "@rim-platform/plugin-sdk";

import {
  deletePod,
  findKubectl,
  getLogs,
  getPod,
  getPods,
  KubeError,
  listNamespaces,
  logArgs,
  MAX_LOG_BYTES,
  readConfig,
  systemKubectl,
  type KubeConfig,
  type KubeErrorKind,
  type Kubectl,
} from "./kubectl.ts";
import { LineBuffer, MAX_LOG_LINES, systemFollow, type Follow } from "./logs.ts";
import {
  containersOf,
  controllerOf,
  defaultContainer,
  summarizePods,
  type PodSummary,
} from "./pods.ts";
import {
  DEFAULT_SETTINGS,
  kubectlFlags,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  NAMESPACE,
  parseSettings,
  type PluginSettings,
} from "./settings.ts";

export const PLUGIN_ID = "chat.rim.k8s-pods";
export const PANEL_ID = "pods";

/** Pods kept in the panel state; the host caps a plugin's panel state at 1 MiB. */
const MAX_PANEL_PODS = 2000;
/** Pods returned to the palette or the agent in one answer. */
const MAX_PAYLOAD_PODS = 500;
const MAX_FILTER_LENGTH = 100;
/** How often streamed log lines reach the panel. */
const LOG_FLUSH_MS = 250;

const CONTAINER_NAME = NAMESPACE;
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

/** The log view: one container's lines, read once or followed as they arrive. */
export interface LogView {
  readonly pod: string;
  readonly namespace: string;
  readonly context: string;
  /** Empty until the pod has been read. */
  readonly container: string;
  readonly containers: readonly string[];
  readonly previous: boolean;
  readonly tailLines: number;
  /** kubectl is streaming new lines. */
  readonly following: boolean;
  readonly loading: boolean;
  readonly lines: readonly string[];
  /** Older lines dropped to keep the view within its limits. */
  readonly dropped: number;
  readonly error: PanelError | null;
  /** Why following stopped by itself, e.g. the container exited. */
  readonly ended: string | null;
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
  /** The open log view, or `null`. */
  readonly logs: LogView | null;
  /** Lines a log view starts with when none are asked for: the last ones chosen. */
  readonly logTailLines: number;
}

/** Calls `run` every `ms` milliseconds until the returned function is called. */
export type Every = (ms: number, run: () => void) => () => void;

export interface K8sPodsOptions {
  /** kubectl run from the binary given; defaults to {@link systemKubectl}. */
  readonly kubectl?: (binary: string) => Kubectl;
  /** Finds kubectl when the settings name no binary; defaults to {@link findKubectl}. */
  readonly findKubectl?: () => string;
  readonly now?: () => Date;
  /** Defaults to `setInterval`. */
  readonly every?: Every;
  /** `kubectl logs --follow` run from the binary given; defaults to {@link systemFollow}. */
  readonly follow?: (binary: string) => Follow;
  /** Defaults to 250 ms. */
  readonly logFlushMs?: number;
}

const defaultEvery: Every = (ms, run) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

/** A fresh plugin with its own selection and timer. */
export function createPlugin(options: K8sPodsOptions = {}) {
  const kubectlAt = options.kubectl ?? systemKubectl;
  const followAt = options.follow ?? systemFollow;
  const find = options.findKubectl ?? findKubectl;
  const now = options.now ?? (() => new Date());
  const every = options.every ?? defaultEvery;
  const logFlushMs = options.logFlushMs ?? LOG_FLUSH_MS;

  let settings: PluginSettings = DEFAULT_SETTINGS;
  /** Settings sets received from the host, so an older answer never replaces a newer set. */
  let settingsReceived = 0;
  let foundKubectl: string | null = null;
  /** The kubectl binary: the one the settings name, else the one found on this device. */
  const binary = () => settings.kubectlPath ?? (foundKubectl ??= find());
  const kubectl: Kubectl = (args) => kubectlAt(binary())([...args, ...kubectlFlags(settings)]);
  const follow: Follow = (args, sink) =>
    followAt(binary())([...args, ...kubectlFlags(settings)], sink);

  let state: PanelState = {
    contexts: [],
    context: null,
    namespace: null,
    namespaces: null,
    filter: "",
    intervalSeconds: settings.intervalSeconds,
    pods: [],
    totalPods: 0,
    fetchedAt: null,
    loading: false,
    error: null,
    lastAction: null,
    logs: null,
    logTailLines: settings.logTailLines,
  };
  let allPods: PodSummary[] = [];
  /** Namespaces per context, listed once per context. */
  const namespaceCache = new Map<string, string[] | null>();
  let host: Host | null = null;
  let panelDenied = false;
  /** The first listing has started, so a settings change applies at once. */
  let started = false;
  let stopTimer: () => void = () => {};
  let inFlight: Promise<PanelState> | null = null;
  let queued: Promise<PanelState> | null = null;
  /** Stops the followed log, if one runs. */
  let stopFollow: () => void = () => {};
  let logFlush: ReturnType<typeof setTimeout> | null = null;
  /** Bumped for each log view, so output of an older one is ignored. */
  let logSession = 0;

  async function publish(patch: Partial<PanelState>): Promise<void> {
    state = { ...state, ...patch };
    await toPanel((ready) => ready.panels.set(PANEL_ID, state));
  }

  /** Change the log view alone, without sending the pods again. */
  async function publishLogs(patch: Partial<LogView> | null): Promise<void> {
    const logs = patch === null || !state.logs ? null : { ...state.logs, ...patch };
    state = { ...state, logs };
    await toPanel((ready) => ready.panels.patch(PANEL_ID, { logs }));
  }

  async function toPanel(update: (ready: Host) => Promise<void>): Promise<void> {
    // The host this update went to, which a shutdown during it does not take away.
    const ready = host;
    if (!ready || panelDenied) return;
    try {
      await update(ready);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        ready.log.warn("the pods panel stays empty: the ui.panel permission is not approved");
      } else {
        ready.log.warn(`could not update the pods panel: ${(error as Error).message}`);
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

  /** The context shown when none is picked: the settings', else the kubeconfig's current one. */
  function defaultContextOf(config: KubeConfig): string {
    return settings.defaultContext ?? config.current ?? config.contexts[0];
  }

  /** The namespace shown in `context` when none is picked. */
  function defaultNamespaceOf(config: KubeConfig, context: string): string {
    return settings.defaultNamespace ?? config.namespaces[context] ?? "default";
  }

  /**
   * Read the kubeconfig and make sure the selection names one of its contexts,
   * else the default one, which may be a context from the settings it lacks.
   */
  async function resolveSelection(): Promise<{
    config: KubeConfig;
    context: string;
    namespace: string;
  }> {
    const config = await readConfig(kubectl);
    const keep = state.context !== null && config.contexts.includes(state.context);
    const context = keep ? (state.context as string) : defaultContextOf(config);
    // A namespace picked before any context was resolved applies to the default one.
    const namespace =
      (keep || state.context === null) && state.namespace
        ? state.namespace
        : defaultNamespaceOf(config, context);
    return { config, context, namespace };
  }

  async function load(): Promise<PanelState> {
    const asked = { context: state.context, namespace: state.namespace };
    let where: { context: string | null; namespace: string | null } = asked;
    await publish({ loading: true });
    try {
      const { config, context, namespace } = await resolveSelection();
      // A pick made while the kubeconfig was read is the queued listing's to resolve.
      if (state.context !== asked.context || state.namespace !== asked.namespace) return state;
      where = { context, namespace };
      await publish({ contexts: config.contexts, context, namespace });
      if (!config.contexts.includes(context)) {
        throw new KubeError("context_missing", `context "${context}" does not exist`);
      }
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
        error: describe(error, where.context, where.namespace, settings),
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

  /**
   * The context and namespace a pod command acts in: the ones given, else the
   * panel's, else the defaults.
   */
  async function targetOf(
    contextArg: string | undefined,
    namespaceArg: string | undefined,
  ): Promise<{ context: string; namespace: string }> {
    const config = await readConfig(kubectl);
    const context = contextArg ?? state.context ?? defaultContextOf(config);
    if (!config.contexts.includes(context)) {
      throw invalid(`context "${context}" is not in your kubeconfig`);
    }
    const namespace =
      namespaceArg ??
      (context === state.context ? state.namespace : null) ??
      defaultNamespaceOf(config, context);
    return { context, namespace };
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
          // Asked for by hand, so namespaces created since are listed too.
          namespaceCache.clear();
          return listingResult(await refresh());
        },
      },
      filter: {
        async run({ args }) {
          const text = optionalString(args.text, "text", MAX_FILTER_LENGTH);
          const namespace = optionalNamespace(args.namespace);
          const context = optionalString(args.context, "context", 253);
          const interval = optionalInterval(args.interval_seconds);
          if (context !== undefined) {
            const config = await readConfig(kubectl).catch((error: unknown) => {
              throw toPluginError(error, null, null, settings);
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
          const pod = requiredName(
            args.pod,
            "use the Restart button next to a pod in the Pods panel",
          );
          const contextArg = optionalString(args.context, "context", 253);
          const namespaceArg = optionalNamespace(args.namespace);

          let context = contextArg ?? state.context;
          let namespace = namespaceArg ?? null;
          try {
            ({ context, namespace } = await targetOf(contextArg, namespaceArg));
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
              error instanceof PluginError
                ? error
                : toPluginError(error, context, namespace, settings);
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
      pod_logs: {
        async run({ args, initiator }) {
          const pod = requiredName(args.pod, "use the Logs button next to a pod in the Pods panel");
          const contextArg = optionalString(args.context, "context", 253);
          const namespaceArg = optionalNamespace(args.namespace);
          const containerArg = optionalString(args.container, "container", 63);
          if (containerArg !== undefined && !CONTAINER_NAME.test(containerArg)) {
            throw invalid(`"${containerArg}" is not a container name`);
          }
          const previous = optionalBoolean(args.previous, "previous") ?? false;
          const following = optionalBoolean(args.follow, "follow") ?? false;
          const tailLines = optionalTailLines(args.tail_lines) ?? state.logTailLines;
          if (following && previous) {
            throw invalid("the previous run has ended, so its logs cannot be followed");
          }
          // The agent reads logs as an answer; only a person's request opens the view.
          const forAgent = initiator === "agent";
          if (forAgent && following) {
            throw invalid("the agent reads logs once; following them is for the Pods panel");
          }

          let context: string | null = contextArg ?? state.context;
          let namespace: string | null = namespaceArg ?? null;
          const session = forAgent ? logSession : ++logSession;
          if (!forAgent) {
            closeFollow();
            await publish({
              logTailLines: tailLines,
              logs: {
                pod,
                namespace: namespaceArg ?? state.namespace ?? "",
                context: context ?? "",
                container: containerArg ?? "",
                containers: [],
                previous,
                tailLines,
                following,
                loading: true,
                lines: [],
                dropped: 0,
                error: null,
                ended: null,
              },
            });
          }
          try {
            ({ context, namespace } = await targetOf(contextArg, namespaceArg));
            const found = await getPod(kubectl, context, namespace, pod);
            const containers = containersOf(found);
            const container = containerArg ?? defaultContainer(found);
            if (container === null) {
              throw new PluginError(`${pod} has no containers`, {
                data: { reason: "no_container" },
              });
            }
            if (!containers.includes(container)) {
              throw invalid(
                `${pod} has no container "${container}"; it has ${containers.join(", ")}`,
              );
            }
            const request = { container, tailLines, previous };
            const where = { pod, namespace, context, container, containers, previous, tailLines };
            const run = previous ? "previous run of " : "";

            if (following) {
              if (session !== logSession) return { payload: { ...where, following, logs: "" } };
              startFollow(session, logArgs(context, namespace, pod, request, true));
              await publishLogs({ ...where, loading: false });
              return {
                payload: { ...where, following, logs: "", truncated: false },
                message: `Following ${container} in ${pod}`,
              };
            }

            const text = await getLogs(kubectl, context, namespace, pod, request);
            const buffer = new LineBuffer();
            buffer.push(text);
            buffer.end();
            const lines = buffer.lines;
            const truncated =
              buffer.dropped > 0 || Buffer.byteLength(text, "utf8") >= MAX_LOG_BYTES;
            if (!forAgent && session === logSession) {
              await publishLogs({ ...where, loading: false, lines, dropped: buffer.dropped });
            }
            return {
              payload: { ...where, following, logs: lines.join("\n"), truncated },
              message:
                lines.length === 0
                  ? `No logs from the ${run}${container} in ${pod}`
                  : `Last ${lines.length} line${lines.length === 1 ? "" : "s"} from the ${run}${container} in ${pod}`,
            };
          } catch (error) {
            const failure = toPluginError(error, context, namespace, settings);
            if (!forAgent && session === logSession) {
              await publishLogs({
                loading: false,
                following: false,
                error: { kind: reasonOf(failure), message: failure.message },
              });
            }
            throw failure;
          }
        },
      },
      stop_logs: {
        async run({ args }) {
          const close = optionalBoolean(args.close, "close") ?? false;
          closeFollow();
          if (close) {
            logSession++;
            await publishLogs(null);
            return { message: "Closed the logs" };
          }
          if (state.logs?.following) await publishLogs({ following: false });
          return { message: "Stopped following the logs" };
        },
      },
    },
    async onReady(ready) {
      host = ready;
      host.log.info("listing pods with kubectl on this device; credentials stay local");
      await readSettings(ready);
      started = true;
      startTimer();
      await refresh();
    },
    // The user saved the settings, or another account signed in: the whole set.
    async onSettingsChanged(values) {
      settingsReceived++;
      await applySettings(values);
    },
    onShutdown() {
      stopTimer();
      closeFollow();
      host = null;
    },
  });

  /** Read the settings at start; without them, the defaults stay. */
  async function readSettings(ready: Host): Promise<void> {
    const received = settingsReceived;
    try {
      const values = await ready.settings.get();
      if (received === settingsReceived) await applySettings(values);
    } catch (error) {
      // A host from before settings has none to give.
      if (error instanceof HostRequestError && error.code === ErrorCode.METHOD_NOT_FOUND) return;
      ready.log.warn(
        `using the default settings, since they could not be read: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Use `values` in place of the settings held so far. Once the pods are listed,
   * a changed default context or namespace replaces the panel's pick, a changed
   * kubeconfig or kubectl lists again, and a changed interval restarts the timer.
   */
  async function applySettings(values: Readonly<Record<string, unknown>>): Promise<void> {
    const { settings: next, ignored } = parseSettings(values);
    if (ignored.length > 0) {
      host?.log.warn(`settings left unset, since their values do not fit: ${ignored.join(", ")}`);
    }
    const before = settings;
    settings = next;
    if (!started) {
      state = { ...state, intervalSeconds: next.intervalSeconds, logTailLines: next.logTailLines };
      return;
    }
    const patch: { -readonly [K in keyof PanelState]?: PanelState[K] } = {};
    if (next.intervalSeconds !== before.intervalSeconds) {
      patch.intervalSeconds = next.intervalSeconds;
    }
    if (next.logTailLines !== before.logTailLines) patch.logTailLines = next.logTailLines;
    const defaultsChanged =
      next.defaultContext !== before.defaultContext ||
      next.defaultNamespace !== before.defaultNamespace;
    const kubectlChanged =
      next.kubeconfig !== before.kubeconfig || next.kubectlPath !== before.kubectlPath;
    if (defaultsChanged) {
      patch.context = null;
      patch.namespace = null;
    }
    if (kubectlChanged) namespaceCache.clear();
    if (Object.keys(patch).length > 0) await publish(patch);
    if (patch.intervalSeconds !== undefined) startTimer();
    if (defaultsChanged || kubectlChanged) void refresh();
  }

  /** Stream a followed log into the view, flushing new lines every `logFlushMs`. */
  function startFollow(session: number, args: readonly string[]): void {
    const buffer = new LineBuffer();
    const flush = () => {
      logFlush = null;
      if (session !== logSession) return;
      void publishLogs({ lines: buffer.lines, dropped: buffer.dropped });
    };
    stopFollow = follow(args, {
      onData(chunk) {
        buffer.push(chunk);
        logFlush ??= setTimeout(flush, logFlushMs);
      },
      onEnd(error) {
        buffer.end();
        if (logFlush) clearTimeout(logFlush);
        logFlush = null;
        stopFollow = () => {};
        if (session !== logSession) return;
        const ended = error
          ? describe(error, state.logs?.context ?? null, state.logs?.namespace ?? null, settings)
              .message
          : "The container stopped writing logs: it exited or the pod is gone.";
        void publishLogs({
          lines: buffer.lines,
          dropped: buffer.dropped,
          following: false,
          ended,
        });
      },
    });
  }

  /** Stop the followed log and flush nothing more from it. */
  function closeFollow(): void {
    stopFollow();
    stopFollow = () => {};
    if (logFlush) clearTimeout(logFlush);
    logFlush = null;
  }

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

/** What the panel and the user see for a failed kubectl call, run with `settings`. */
export function describe(
  error: unknown,
  context: string | null,
  namespace: string | null,
  settings: PluginSettings = DEFAULT_SETTINGS,
): PanelError {
  if (!(error instanceof KubeError)) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const ctx = context ? `"${context}"` : "the current context";
  const ns = namespace ? `"${namespace}"` : "this namespace";
  const message = ((): string => {
    switch (error.kind) {
      case "kubectl_missing":
        return settings.kubectlPath !== null
          ? "kubectl was not found at the kubectl path in the plugin's settings. Correct it there, or clear it to use the kubectl on your PATH."
          : "kubectl was not found on this device. Install kubectl and restart RIM, so the plugin can find it on your PATH.";
      case "no_kubeconfig":
        return settings.kubeconfig !== null
          ? "The kubeconfig file in the plugin's settings could not be read or has no contexts. Correct it there, or clear it to use $KUBECONFIG or ~/.kube/config."
          : "No kubeconfig found. The plugin reads the same file kubectl does: $KUBECONFIG, or ~/.kube/config.";
      case "context_missing":
        return context !== null && context === settings.defaultContext
          ? `The context ${ctx}, the default context in the plugin's settings, is not in your kubeconfig. Pick another context, or change the setting.`
          : `The context ${ctx} is not in your kubeconfig. Pick another context.`;
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
  settings: PluginSettings,
): PluginError {
  if (error instanceof PluginError) return error;
  const described = describe(error, context, namespace, settings);
  return new PluginError(described.message, { data: { reason: described.kind } });
}

function reasonOf(error: PluginError): KubeErrorKind {
  const reason = (error.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? (reason as KubeErrorKind) : "failed";
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

function requiredName(value: unknown, hint: string): string {
  if (value === undefined || value === null || value === "") {
    throw invalid(`pod is required: ${hint}`);
  }
  if (typeof value !== "string" || !POD_NAME.test(value)) {
    throw invalid(`"${String(value)}" is not a pod name`);
  }
  return value;
}

function optionalNamespace(value: unknown): string | undefined {
  const namespace = optionalString(value, "namespace", 63);
  if (namespace !== undefined && !NAMESPACE.test(namespace)) {
    throw invalid(`"${namespace}" is not a namespace name`);
  }
  return namespace;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`${name} must be true or false`);
}

function optionalTailLines(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const lines = typeof value === "string" ? Number(value) : value;
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
    throw invalid(`tail_lines must be a whole number from 1 to ${MAX_LOG_LINES}`);
  }
  return lines;
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
