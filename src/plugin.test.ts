// Tests the pods plugin against the SDK's in-memory host and a pretend
// cluster: no RIM app, no kubectl and no cluster needed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startTestHost, validateManifest } from "@rim-platform/plugin-sdk/testing";

import { createPlugin, describe as describeError, PANEL_ID, type PanelState } from "./plugin.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { KubeError, type Kubectl } from "./kubectl.ts";
import type { FollowSink } from "./logs.ts";
import { fakeKubectl, type Scenario } from "./test/fake-cluster.ts";

const MANIFEST = `${import.meta.dirname}/../rim-plugin.json`;
const NOW = new Date("2026-10-08T12:00:00Z");
const CONFIRMED = { confirmed: true } as const;

/** The binary the plugin finds when its settings name none. */
const FOUND_KUBECTL = "/found/kubectl";

/** How the test host answers `rim.settings.get`. */
interface SettingsAnswer {
  /** The saved settings; without them a read fails as `settingsError` says. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** The error a read gets; defaults to `METHOD_NOT_FOUND`, as from a host before settings. */
  readonly settingsError?: { code: number; message: string; data?: unknown };
}

function start(
  scenario: Scenario = "ok",
  grantedCapabilities = ["ui.panel", "ui.notify"],
  wrap: (kubectl: Kubectl) => Kubectl = (kubectl) => kubectl,
  { settings, settingsError }: SettingsAnswer = {},
) {
  const fake = fakeKubectl(scenario);
  /** The binary of each kubectl call and followed log, in order. */
  const binaries: string[] = [];
  /** Each `kubectl logs --follow` started, with its output sink and whether it was stopped. */
  const follows: Array<{ args: readonly string[]; sink: FollowSink; stopped: boolean }> = [];
  const ticks: Array<() => void> = [];
  const intervals: number[] = [];
  const panels: PanelState[] = [];
  const plugin = createPlugin({
    kubectl: (binary) => {
      binaries.push(binary);
      return wrap(fake.kubectl);
    },
    findKubectl: () => FOUND_KUBECTL,
    now: () => NOW,
    every: (ms, run) => {
      intervals.push(ms);
      ticks.push(run);
      return () => {
        intervals.push(-ms);
      };
    },
    follow: (binary) => (args, sink) => {
      binaries.push(binary);
      const started = { args, sink, stopped: false };
      follows.push(started);
      return () => {
        started.stopped = true;
      };
    },
    logFlushMs: 0,
  });
  const host = startTestHost(plugin, {
    manifestPath: MANIFEST,
    grantedCapabilities,
    settings,
    onRequest(method, params) {
      if (method === "rim.settings.get") {
        throw settingsError ?? { code: -32601, message: "method not found: rim.settings.get" };
      }
      const p = params as { panel_id: string; state: PanelState; patch?: boolean };
      if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) {
        panels.push(p.patch ? { ...(panels.at(-1) as PanelState), ...p.state } : p.state);
      }
      return { ok: true };
    },
  });
  const panel = () => panels.at(-1) as PanelState;
  return { host, fake, follows, ticks, intervals, panels, panel, binaries };
}

/** Wait until the plugin's first listing reached the panel. */
async function settled(panel: () => PanelState | undefined) {
  for (let i = 0; i < 100; i++) {
    const state = panel();
    if (state && !state.loading && (state.fetchedAt || state.error)) return state;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("the panel never settled");
}

describe("k8s-pods plugin", () => {
  it("has a manifest the host installs, with restart_pod the one dangerous command", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(manifest.capabilities).toEqual(["ui.panel", "ui.notify"]);
    expect(
      manifest.commands.map((c: { id: string; dangerous: boolean; keybind_capable: boolean }) => [
        c.id,
        c.dangerous,
        c.keybind_capable,
      ]),
    ).toEqual([
      ["refresh", false, true],
      ["filter", false, true],
      ["restart_pod", true, false],
      ["pod_logs", false, false],
      ["stop_logs", false, true],
    ]);
    // Logs reach the agent only once the user allows pod_logs for it in the host's settings.
    const aiCallable = manifest.commands
      .filter((c: { ai_callable: boolean }) => c.ai_callable)
      .map((c: { id: string }) => c.id);
    expect(aiCallable).toEqual(["refresh", "filter", "restart_pod", "pod_logs"]);
    expect(manifest.description).toContain("credentials never leave this device");
    // No secret settings: the plugin never asks for a credential of its own.
    expect(
      manifest.settings_schema.map(
        (s: { key: string; value_type: string; is_secret?: boolean }) => [
          s.key,
          s.value_type,
          s.is_secret ?? false,
        ],
      ),
    ).toEqual([
      ["kubeconfig", "path", false],
      ["kubectl_path", "path", false],
      ["default_context", "string", false],
      ["default_namespace", "string", false],
      ["refresh_interval_seconds", "integer", false],
      ["log_tail_lines", "integer", false],
    ]);
  });

  it("lists the current context's pods on start and refreshes on the interval", async () => {
    const t = start();
    await t.host.handshake();
    const state = await settled(t.panel);

    expect(state.context).toBe("kind-dev");
    expect(state.contexts).toEqual(["kind-dev", "prod"]);
    expect(state.namespace).toBe("shop"); // the context's own namespace
    expect(state.namespaces).toEqual(["default", "kube-system", "shop"]);
    expect(state.error).toBeNull();
    expect(state.pods.map((p) => [p.name, p.status, p.ready, p.restarts, p.age])).toEqual([
      ["debug", "Running", "1/1", 0, "90s"],
      ["web-7f9c-abcde", "Running", "1/1", 0, "2h"],
      ["worker-5d8b-fghij", "CrashLoopBackOff", "1/2", 7, "24h"],
    ]);
    expect(t.intervals).toEqual([15_000]);

    const calls = t.fake.calls.length;
    t.ticks[0]();
    await new Promise((done) => setTimeout(done, 20));
    expect(t.fake.calls.length).toBeGreaterThan(calls);
    await t.host.shutdown();
    expect(t.intervals).toEqual([15_000, -15_000]);
  });

  it("refreshes on demand and answers with the pods", async () => {
    const t = start();
    await t.host.handshake();
    await settled(t.panel);
    const answer = await t.host.execute("refresh");
    expect(answer.result?.message).toBe("3 pods in shop (kind-dev)");
    const payload = answer.result?.payload as { pods: { name: string }[]; totalPods: number };
    expect(payload.totalPods).toBe(3);
    expect(payload.pods[2]).toEqual({
      name: "worker-5d8b-fghij",
      status: "CrashLoopBackOff",
      ready: "1/2",
      restarts: 7,
      age: "24h",
      node: "kind-control-plane",
    });
    await t.host.shutdown();
  });

  it("filters by text, namespace, context and interval", async () => {
    const t = start();
    await t.host.handshake();
    await settled(t.panel);

    let answer = await t.host.execute("filter", { text: "crash" });
    expect(answer.result?.message).toBe('1 of 3 pods match "crash" in shop (kind-dev)');
    expect(t.panel().pods.map((p) => p.name)).toEqual(["worker-5d8b-fghij"]);

    // Without arguments the text filter is cleared.
    answer = await t.host.execute("filter");
    expect(answer.result?.message).toBe("3 pods in shop (kind-dev)");
    expect(t.panel().filter).toBe("");
    expect(t.panel().pods).toHaveLength(3);

    answer = await t.host.execute("filter", { namespace: "default", interval_seconds: "60" });
    expect(answer.result?.message).toBe("0 pods in default (kind-dev)");
    expect(t.intervals).toEqual([15_000, -15_000, 60_000]);

    // A new context starts in that context's namespace unless one is given.
    answer = await t.host.execute("filter", { context: "prod" });
    expect(answer.error).toBeUndefined();
    expect(t.panel()).toMatchObject({ context: "prod", namespace: "default" });

    for (const [args, message] of [
      [{ namespace: "Not_A_Namespace" }, '"Not_A_Namespace" is not a namespace name'],
      [{ context: "staging" }, 'context "staging" is not in your kubeconfig'],
      [{ interval_seconds: 2 }, "interval_seconds must be 0 or a whole number from 5 to 3600"],
      [{ text: 7 }, "text must be a string"],
    ] as const) {
      const refused = await t.host.execute("filter", args);
      expect(refused.error).toMatchObject({ code: -32602, message });
    }
    await t.host.shutdown();
  });

  it("keeps a namespace picked while the first listing still runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    let first = true;
    const t = start("ok", undefined, (kubectl) => async (args) => {
      if (args[0] === "config" && first) {
        first = false;
        await gate;
      }
      return kubectl(args);
    });
    await t.host.handshake();
    const picked = t.host.execute("filter", { namespace: "default" });
    release();
    expect((await picked).result?.message).toBe("0 pods in default (kind-dev)");
    expect(t.panel()).toMatchObject({ namespace: "default", loading: false });
    await t.host.shutdown();
  });

  it("restarts a controlled pod only after the user confirms, and reports it", async () => {
    const t = start();
    await t.host.handshake();
    await settled(t.panel);

    // The SDK refuses an unconfirmed run and the agent outright, before kubectl runs.
    for (const options of [{}, { initiator: "agent", confirmed: true }] as const) {
      const refused = await t.host.execute("restart_pod", { pod: "web-7f9c-abcde" }, options);
      expect(refused.error?.data).toEqual({ reason: "confirmation_required" });
    }
    expect(t.fake.calls.some((c) => c[0] === "delete")).toBe(false);

    const answer = await t.host.execute("restart_pod", { pod: "web-7f9c-abcde" }, CONFIRMED);
    expect(answer.result).toEqual({
      payload: {
        pod: "web-7f9c-abcde",
        namespace: "shop",
        context: "kind-dev",
        controller: "ReplicaSet/web-7f9c",
      },
      message: "Restarted web-7f9c-abcde in shop: ReplicaSet/web-7f9c starts a new pod.",
    });
    expect(t.fake.calls).toContainEqual([
      "delete",
      "pod",
      "web-7f9c-abcde",
      "--wait=false",
      "--context=kind-dev",
      "--namespace=shop",
      "--request-timeout=15s",
    ]);
    expect(t.panel().lastAction).toMatchObject({ pod: "web-7f9c-abcde", ok: true });
    await t.host.shutdown();
  });

  it("refuses to restart a pod nothing would recreate", async () => {
    const t = start();
    await t.host.handshake();
    await settled(t.panel);
    const answer = await t.host.execute("restart_pod", { pod: "debug" }, CONFIRMED);
    expect(answer.error?.data).toEqual({ reason: "no_controller" });
    expect(t.fake.calls.some((c) => c[0] === "delete")).toBe(false);
    expect(t.panel().lastAction).toMatchObject({ pod: "debug", ok: false });

    const missing = await t.host.execute("restart_pod", { pod: "gone" }, CONFIRMED);
    expect(missing.error?.data).toEqual({ reason: "not_found" });
    const noPod = await t.host.execute("restart_pod", {}, CONFIRMED);
    expect(noPod.error?.message).toMatch(/^pod is required/);
    await t.host.shutdown();
  });

  it("refuses to restart a static pod, which deleting would not restart", async () => {
    const mirror = {
      metadata: {
        name: "kube-apiserver-cp",
        ownerReferences: [{ kind: "Node", name: "cp", controller: true }],
      },
    };
    const t = start(
      "ok",
      undefined,
      (kubectl) => async (args) =>
        args[0] === "get" && args[2] === "kube-apiserver-cp"
          ? JSON.stringify(mirror)
          : kubectl(args),
    );
    await t.host.handshake();
    await settled(t.panel);
    const answer = await t.host.execute("restart_pod", { pod: "kube-apiserver-cp" }, CONFIRMED);
    expect(answer.error?.data).toEqual({ reason: "static_pod" });
    expect(t.fake.calls.some((c) => c[0] === "delete")).toBe(false);
    await t.host.shutdown();
  });

  it.each([
    ["no-config", "no_kubeconfig", /^No kubeconfig found/],
    ["unreachable", "unreachable", /^Cannot reach the cluster of "kind-dev"/],
    ["unauthorized", "unauthorized", /did not accept your credentials/],
    ["forbidden", "forbidden", /may not do this in the namespace "shop" on "kind-dev"/],
  ] as const)("explains %s in the panel and to the caller", async (scenario, kind, message) => {
    const t = start(scenario);
    await t.host.handshake();
    const state = await settled(t.panel);
    expect(state.error).toMatchObject({ kind });
    expect(state.error?.message).toMatch(message);
    expect(state.pods).toEqual([]);

    const answer = await t.host.execute("refresh");
    expect(answer.error?.data).toEqual({ reason: kind });
    expect(answer.error?.message).toMatch(message);
    await t.host.shutdown();
  });

  it("still lists pods when the account may not list namespaces", async () => {
    const t = start("namespaces-forbidden");
    await t.host.handshake();
    const state = await settled(t.panel);
    expect(state.error).toBeNull();
    expect(state.namespaces).toBeNull();
    expect(state.pods).toHaveLength(3);
    await t.host.shutdown();
  });

  it("keeps working without the panel permission", async () => {
    const t = start("ok", []);
    await t.host.handshake();
    const answer = await t.host.execute("refresh");
    expect(answer.result?.message).toBe("3 pods in shop (kind-dev)");
    expect(t.panels).toEqual([]);
    expect(t.host.logs.some((l) => /ui\.panel permission is not approved/.test(l.message))).toBe(
      true,
    );
    await t.host.shutdown();
  });

  describe("logs", () => {
    const flushed = () => new Promise((done) => setTimeout(done, 10));

    it("shows the default container's last 100 lines and remembers another count", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      let answer = await t.host.execute("pod_logs", { pod: "web-7f9c-abcde" });
      expect(answer.result?.message).toBe("Last 100 lines from the web in web-7f9c-abcde");
      expect(t.fake.calls).toContainEqual([
        "logs",
        "web-7f9c-abcde",
        "--container=web",
        "--tail=100",
        "--limit-bytes=262144",
        "--request-timeout=15s",
        "--context=kind-dev",
        "--namespace=shop",
      ]);
      expect(t.panel().logs).toMatchObject({
        pod: "web-7f9c-abcde",
        container: "web",
        containers: ["web"],
        tailLines: 100,
        following: false,
        loading: false,
        error: null,
      });
      expect(t.panel().logs?.lines.at(-1)).toBe("GET /health 200 150ms");

      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", tail_lines: "20" });
      answer = await t.host.execute("pod_logs", { pod: "web-7f9c-abcde" });
      expect(answer.result?.message).toBe("Last 20 lines from the web in web-7f9c-abcde");
      expect(t.panel().logTailLines).toBe(20);
      await t.host.shutdown();
    });

    it("reads plain text from another container and from the previous run", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      await t.host.execute("pod_logs", { pod: "worker-5d8b-fghij" });
      expect(t.panel().logs).toMatchObject({
        container: "worker",
        containers: ["worker", "sidecar"],
        lines: ["INFO starting worker", "ERROR queue unreachable"],
      });
      await t.host.execute("pod_logs", { pod: "worker-5d8b-fghij", container: "sidecar" });
      expect(t.panel().logs?.lines).toEqual(["proxy ready"]);
      await t.host.execute("pod_logs", { pod: "worker-5d8b-fghij", previous: true });
      expect(t.panel().logs).toMatchObject({
        previous: true,
        lines: ["INFO starting worker", "panic: queue unreachable"],
      });

      const none = await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", previous: "true" });
      expect(none.error?.data).toEqual({ reason: "not_found" });
      expect(t.panel().logs).toMatchObject({ pod: "web-7f9c-abcde", loading: false });
      expect(t.panel().logs?.error?.message).toMatch(/previous terminated container "web"/);
      await t.host.shutdown();
    });

    it("follows new lines in the panel until stopped, then closes", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      const answer = await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });
      expect(answer.result?.message).toBe("Following web in web-7f9c-abcde");
      expect(t.follows).toHaveLength(1);
      expect(t.follows[0].args).toEqual([
        "logs",
        "web-7f9c-abcde",
        "--container=web",
        "--tail=100",
        "--follow",
        "--context=kind-dev",
        "--namespace=shop",
      ]);
      t.follows[0].sink.onData("one\ntw");
      t.follows[0].sink.onData("o\nthree\n");
      await flushed();
      expect(t.panel().logs).toMatchObject({
        following: true,
        lines: ["one", "two", "three"],
      });

      await t.host.execute("stop_logs");
      expect(t.follows[0].stopped).toBe(true);
      expect(t.panel().logs).toMatchObject({ following: false, lines: ["one", "two", "three"] });
      await t.host.execute("stop_logs", { close: true });
      expect(t.panel().logs).toBeNull();
      await t.host.shutdown();
    });

    it("says why a followed log ended, and ignores a stream it replaced", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });
      await t.host.execute("pod_logs", { pod: "worker-5d8b-fghij", follow: true });
      expect(t.follows[0].stopped).toBe(true);
      t.follows[0].sink.onData("stale\n");
      t.follows[1].sink.onData("fresh\n");
      t.follows[1].sink.onEnd(null);
      await flushed();
      expect(t.panel().logs).toMatchObject({
        pod: "worker-5d8b-fghij",
        following: false,
        lines: ["fresh"],
        ended: "The container stopped writing logs: it exited or the pod is gone.",
      });

      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });
      t.follows[2].sink.onEnd(new KubeError("unreachable", "dial tcp: i/o timeout"));
      await flushed();
      expect(t.panel().logs?.ended).toMatch(/^Cannot reach the cluster of "kind-dev"/);

      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });
      await t.host.shutdown();
      expect(t.follows[3].stopped).toBe(true);
    });

    it("answers the agent without opening the panel's view, and never follows for it", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      const agent = { initiator: "agent" } as const;
      const answer = await t.host.execute("pod_logs", { pod: "worker-5d8b-fghij" }, agent);
      expect(answer.result?.payload).toMatchObject({
        container: "worker",
        logs: "INFO starting worker\nERROR queue unreachable",
        truncated: false,
        following: false,
      });
      expect(t.panel().logs).toBeNull();

      const follow = await t.host.execute(
        "pod_logs",
        { pod: "web-7f9c-abcde", follow: true },
        agent,
      );
      expect(follow.error?.message).toMatch(/^the agent reads logs once/);
      expect(t.follows).toHaveLength(0);
      await t.host.shutdown();
    });

    it("refuses arguments kubectl should never see", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);

      for (const [args, message] of [
        [{}, /^pod is required: use the Logs button/],
        [{ pod: "web-7f9c-abcde", container: "--all" }, /is not a container name/],
        [{ pod: "web-7f9c-abcde", container: "db" }, /has no container "db"; it has web/],
        [{ pod: "web-7f9c-abcde", tail_lines: 0 }, /^tail_lines must be a whole number/],
        [{ pod: "web-7f9c-abcde", tail_lines: 5001 }, /^tail_lines must be a whole number/],
        [{ pod: "web-7f9c-abcde", previous: "maybe" }, /^previous must be true or false/],
        [{ pod: "web-7f9c-abcde", previous: true, follow: true }, /cannot be followed/],
      ] as const) {
        const refused = await t.host.execute("pod_logs", args);
        expect(refused.error?.message).toMatch(message);
      }
      expect(t.fake.calls.some((c) => c[0] === "logs")).toBe(false);
      await t.host.shutdown();
    });
  });

  describe("settings", () => {
    /** The settings get, among the frames the plugin sent. */
    const readSettings = (t: ReturnType<typeof start>) =>
      t.host.frames.filter((f) => (f as { method?: string }).method === "rim.settings.get");

    it("uses the defaults when the user saved none", async () => {
      const t = start("ok", undefined, undefined, { settings: {} });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(readSettings(t)).toHaveLength(1);
      expect(state).toMatchObject({
        context: "kind-dev",
        namespace: "shop",
        intervalSeconds: 15,
        logTailLines: 100,
      });
      expect(t.intervals).toEqual([15_000]);
      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });
      expect(t.follows[0].args).toContain("--tail=100");
      expect(new Set(t.binaries)).toEqual(new Set([FOUND_KUBECTL]));
      expect(t.fake.calls.flat().some((a) => a.startsWith("--kubeconfig"))).toBe(false);
      expect(t.host.logs.filter((l) => l.level === "warn")).toEqual([]);
      await t.host.shutdown();
    });

    it("runs the kubectl the settings name, with their kubeconfig on every call", async () => {
      const t = start("ok", undefined, undefined, {
        settings: { kubectl_path: "/opt/kubectl/kubectl", kubeconfig: "~/.kube/dev.yaml" },
      });
      await t.host.handshake();
      expect((await settled(t.panel)).error).toBeNull();
      await t.host.execute("pod_logs", { pod: "web-7f9c-abcde", follow: true });

      const flag = `--kubeconfig=${join(homedir(), ".kube/dev.yaml")}`;
      expect(t.fake.calls.length).toBeGreaterThan(0);
      for (const call of [...t.fake.calls, t.follows[0].args]) {
        expect(call.at(-1)).toBe(flag);
      }
      expect(t.fake.calls[0]).toEqual(["config", "view", "-o", "json", flag]);
      expect(new Set(t.binaries)).toEqual(new Set(["/opt/kubectl/kubectl"]));
      await t.host.shutdown();
    });

    it("says when the kubectl or kubeconfig the settings name is not there", () => {
      const missing = describeError(
        new KubeError("kubectl_missing", "x was not found"),
        null,
        null,
        {
          ...DEFAULT_SETTINGS,
          kubectlPath: "/nowhere/kubectl",
        },
      );
      expect(missing.message).toMatch(
        /^kubectl was not found at the kubectl path in the plugin's settings/,
      );
      const config = describeError(new KubeError("no_kubeconfig", "stat"), null, null, {
        ...DEFAULT_SETTINGS,
        kubeconfig: "/nowhere/config",
      });
      expect(config.message).toMatch(
        /^The kubeconfig file in the plugin's settings could not be read/,
      );
    });

    it("opens on the default context and namespace, in every context until picked", async () => {
      const t = start("ok", undefined, undefined, {
        settings: { default_context: "prod", default_namespace: "kube-system" },
      });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(state).toMatchObject({ context: "prod", namespace: "kube-system", error: null });
      expect(t.fake.calls).toContainEqual(
        expect.arrayContaining(["get", "pods", "--context=prod", "--namespace=kube-system"]),
      );

      await t.host.execute("filter", { context: "kind-dev" });
      expect(t.panel()).toMatchObject({ context: "kind-dev", namespace: "kube-system" });
      await t.host.execute("filter", { namespace: "shop" });
      expect(t.panel()).toMatchObject({ context: "kind-dev", namespace: "shop" });
      await t.host.shutdown();
    });

    it("says so when the default context is not in the kubeconfig, and lets you pick one", async () => {
      const t = start("ok", undefined, undefined, { settings: { default_context: "staging" } });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(state.contexts).toEqual(["kind-dev", "prod"]);
      expect(state.error).toMatchObject({ kind: "context_missing" });
      expect(state.error?.message).toBe(
        'The context "staging", the default context in the plugin\'s settings, is not in your kubeconfig. Pick another context, or change the setting.',
      );
      expect(t.fake.calls.some((c) => c.includes("--context=staging"))).toBe(false);

      const picked = await t.host.execute("filter", { context: "kind-dev" });
      expect(picked.result?.message).toBe("3 pods in shop (kind-dev)");
      await t.host.shutdown();
    });

    it("refreshes on the interval and starts logs with the line count the settings give", async () => {
      const t = start("ok", undefined, undefined, {
        settings: { refresh_interval_seconds: 60, log_tail_lines: 500 },
      });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(state).toMatchObject({ intervalSeconds: 60, logTailLines: 500 });
      expect(t.intervals).toEqual([60_000]);
      const answer = await t.host.execute("pod_logs", { pod: "web-7f9c-abcde" });
      expect(answer.result?.message).toBe("Last 150 lines from the web in web-7f9c-abcde");
      expect(t.fake.calls).toContainEqual(expect.arrayContaining(["logs", "--tail=500"]));
      await t.host.shutdown();
    });

    it("applies changed settings at once, and keeps a pick the change does not touch", async () => {
      const t = start("ok", undefined, undefined, { settings: {} });
      await t.host.handshake();
      await settled(t.panel);

      t.host.changeSettings({
        default_namespace: "default",
        refresh_interval_seconds: 30,
        log_tail_lines: 1000,
        kubectl_path: "/usr/local/bin/kubectl",
      });
      await vi.waitFor(() =>
        expect(t.panel()).toMatchObject({
          namespace: "default",
          intervalSeconds: 30,
          logTailLines: 1000,
          loading: false,
        }),
      );
      expect(t.intervals).toEqual([15_000, -15_000, 30_000]);
      expect(t.binaries.at(-1)).toBe("/usr/local/bin/kubectl");

      // A pick made in the panel stays while the default namespace stays the same.
      await t.host.execute("filter", { namespace: "kube-system" });
      t.host.changeSettings({
        default_namespace: "default",
        refresh_interval_seconds: 30,
        log_tail_lines: 500,
        kubectl_path: "/usr/local/bin/kubectl",
      });
      await vi.waitFor(() => expect(t.panel().logTailLines).toBe(500));
      expect(t.panel().namespace).toBe("kube-system");
      expect(t.intervals).toEqual([15_000, -15_000, 30_000]);

      // A cleared setting is missing from the new set: back to the defaults.
      t.host.changeSettings({});
      await vi.waitFor(() =>
        expect(t.panel()).toMatchObject({
          namespace: "shop",
          intervalSeconds: 15,
          logTailLines: 100,
          loading: false,
        }),
      );
      await t.host.execute("refresh");
      expect(t.binaries.at(-1)).toBe(FOUND_KUBECTL);
      await t.host.shutdown();
    });

    it("keeps the defaults when the settings cannot be read", async () => {
      const t = start("ok", undefined, undefined, {
        settingsError: {
          code: -32603,
          message: "the secret vault is locked",
          data: { reason: "secretsLocked" },
        },
      });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(state).toMatchObject({ context: "kind-dev", namespace: "shop", error: null });
      expect(t.intervals).toEqual([15_000]);
      expect(
        t.host.logs.some(
          (l) =>
            l.level === "warn" &&
            /^using the default settings, since they could not be read: .*vault is locked/.test(
              l.message,
            ),
        ),
      ).toBe(true);
      await t.host.shutdown();
    });

    it("keeps the defaults on a host from before settings, without a warning", async () => {
      const t = start();
      await t.host.handshake();
      await settled(t.panel);
      expect(readSettings(t)).toHaveLength(1);
      expect(t.host.logs.filter((l) => l.level === "warn")).toEqual([]);
      await t.host.shutdown();
    });

    it("leaves values that do not fit unset, and says which", async () => {
      const t = start("ok", undefined, undefined, {
        settings: { refresh_interval_seconds: 2, default_namespace: "Not_A_Namespace" },
      });
      await t.host.handshake();
      const state = await settled(t.panel);
      expect(state).toMatchObject({ namespace: "shop", intervalSeconds: 15 });
      expect(t.host.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            "settings left unset, since their values do not fit: default_namespace, refresh_interval_seconds",
        }),
      );
      await t.host.shutdown();
    });
  });
});
