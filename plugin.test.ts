// Tests the pods plugin against the SDK's in-memory host and a pretend
// cluster: no RIM app, no kubectl and no cluster needed.
import { describe, expect, it } from "vitest";
import { startTestHost } from "@rim-platform/plugin-sdk/testing";

import { createPlugin, PANEL_ID, type PanelState } from "./plugin.ts";
import type { Kubectl } from "./kubectl.ts";
import { fakeKubectl, type Scenario } from "./test/fake-cluster.ts";

const MANIFEST = `${import.meta.dirname}/rim-plugin.json`;
const NOW = new Date("2026-10-08T12:00:00Z");
const CONFIRMED = { confirmed: true } as const;

function start(
  scenario: Scenario = "ok",
  grantedCapabilities = ["ui.panel", "ui.notify"],
  wrap: (kubectl: Kubectl) => Kubectl = (kubectl) => kubectl,
) {
  const fake = fakeKubectl(scenario);
  const ticks: Array<() => void> = [];
  const intervals: number[] = [];
  const panels: PanelState[] = [];
  const plugin = createPlugin({
    kubectl: wrap(fake.kubectl),
    now: () => NOW,
    every: (ms, run) => {
      intervals.push(ms);
      ticks.push(run);
      return () => {
        intervals.push(-ms);
      };
    },
  });
  const host = startTestHost(plugin, {
    manifestPath: MANIFEST,
    grantedCapabilities,
    onRequest(method, params) {
      const p = params as { panel_id: string; state: PanelState };
      if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) panels.push(p.state);
      return { ok: true };
    },
  });
  const panel = () => panels.at(-1) as PanelState;
  return { host, fake, ticks, intervals, panels, panel };
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
});
