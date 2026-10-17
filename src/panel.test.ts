// @vitest-environment jsdom
// The Pods panel page in a DOM: it renders the state the plugin publishes and
// asks the host to run commands, never running anything itself.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogView, PanelState } from "./plugin.ts";

const dir = `${import.meta.dirname}/../panels/pods`;
const html = readFileSync(`${dir}/index.html`, "utf8");
const script = readFileSync(`${dir}/app.js`, "utf8");

const STATE: PanelState = {
  contexts: ["kind-dev", "prod"],
  context: "kind-dev",
  namespace: "shop",
  namespaces: ["default", "shop"],
  filter: "",
  intervalSeconds: 15,
  pods: [
    {
      name: "web-1",
      status: "Running",
      ready: "1/1",
      restarts: 0,
      age: "2h",
      createdAt: null,
      node: "node-a",
      controller: "ReplicaSet/web",
    },
    {
      name: "<img src=x onerror=alert(1)>",
      status: "CrashLoopBackOff",
      ready: "0/1",
      restarts: 4,
      age: "5m",
      createdAt: null,
      node: "node-b",
      controller: "ReplicaSet/evil",
    },
  ],
  totalPods: 2,
  fetchedAt: new Date().toISOString(),
  loading: false,
  error: null,
  lastAction: null,
  logs: null,
  logTailLines: 100,
};

const LOGS: LogView = {
  pod: "web-1",
  namespace: "shop",
  context: "kind-dev",
  container: "web",
  containers: ["web", "proxy"],
  previous: false,
  tailLines: 100,
  following: true,
  loading: false,
  lines: ["started", "<b>not bold</b>"],
  dropped: 0,
  error: null,
  ended: null,
};

const commands = () =>
  sent
    .filter((m) => m.type === "rim.command.execute")
    .map((m) => [(m.commandId as string).replace("plugin.chat.rim.k8s-pods.", ""), m.args]);

let sent: Array<Record<string, unknown>>;
/** Listeners the page added to window and document, removed after each test. */
let added: Array<() => void>;

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

function press(key: string) {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  added = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      add(type, listener, options);
      added.push(() => target.removeEventListener(type, listener, options));
    });
  }
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as Record<string, unknown>);
  });
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[^>]*><\/script>/, "");
  new Function(script)();
});

afterEach(() => {
  for (const remove of added) remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Pods panel", () => {
  it("renders the pods it is sent, as text", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    const rows = [...document.querySelectorAll("#rows tr")].map((row) =>
      [...row.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ["web-1", "Running", "1/1", "0", "2h", "node-a"],
      ["<img src=x onerror=alert(1)>", "CrashLoopBackOff", "0/1", "4", "5m", "node-b"],
    ]);
    expect(document.querySelector("#rows img")).toBeNull();
    expect((document.getElementById("context") as HTMLSelectElement).value).toBe("kind-dev");
    expect((document.getElementById("namespace") as HTMLSelectElement).value).toBe("shop");
  });

  it("ignores messages that do not come from the host", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "panel.state_update", state: STATE } }),
    );
    expect(document.querySelectorAll("#rows tr")).toHaveLength(0);
  });

  it("shows the plugin's error and a typed namespace when namespaces cannot be listed", () => {
    fromHost({
      type: "panel.state_update",
      state: {
        ...STATE,
        pods: [],
        namespaces: null,
        error: { kind: "unreachable", message: "Cannot reach the cluster.", detail: "dial tcp" },
      },
    });
    expect(document.getElementById("error")?.hidden).toBe(false);
    expect(document.getElementById("error")?.textContent).toBe(
      "Cannot reach the cluster.kubectl: dial tcp",
    );
    expect(document.getElementById("namespace")?.hidden).toBe(true);
    expect((document.getElementById("namespace-input") as HTMLInputElement).value).toBe("shop");
  });

  it("asks the host to restart the selected pod and notifies with the answer", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    press("j");
    press("x");
    expect(sent).toEqual([
      {
        type: "rim.command.execute",
        commandId: "plugin.chat.rim.k8s-pods.restart_pod",
        args: { pod: "<img src=x onerror=alert(1)>", namespace: "shop", context: "kind-dev" },
        requestId: "pods-1",
      },
    ]);
    // A panel never claims the confirmation itself.
    expect(sent[0]).not.toHaveProperty("confirmed");

    fromHost({ type: "rim.command.result", requestId: "pods-1", ok: true, message: "Restarted." });
    expect(sent[1]).toEqual({
      type: "rim.ui.notification.show",
      title: "Pod restarted",
      body: "Restarted.",
    });

    // Declining the host's confirmation sends nothing more.
    press("x");
    fromHost({ type: "rim.command.result", requestId: "pods-2", ok: false, cancelled: true });
    expect(sent).toHaveLength(3);
  });

  it("says the plugin is not running once its state goes away", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    fromHost({ type: "panel.state_update", state: null });
    expect(document.getElementById("table")?.hidden).toBe(true);
    expect(document.getElementById("empty")?.textContent).toContain("not running");
    press("x");
    expect(sent).toHaveLength(0);
  });

  it("refreshes and filters through the plugin's commands", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    press("r");
    const filter = document.getElementById("filter") as HTMLInputElement;
    filter.value = "web";
    filter.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(300);
    const context = document.getElementById("context") as HTMLSelectElement;
    context.value = "prod";
    context.dispatchEvent(new Event("change"));
    expect(sent.map((m) => [m.commandId, m.args])).toEqual([
      ["plugin.chat.rim.k8s-pods.refresh", {}],
      ["plugin.chat.rim.k8s-pods.filter", { text: "web" }],
      ["plugin.chat.rim.k8s-pods.filter", { context: "prod" }],
    ]);
  });

  it("keeps the selected pod when a refresh reorders the list", () => {
    fromHost({ type: "panel.state_update", state: STATE });
    press("j");
    fromHost({ type: "panel.state_update", state: { ...STATE, pods: [...STATE.pods].reverse() } });
    expect(document.querySelector("#rows tr.selected td")?.textContent).toBe(STATE.pods[1].name);
    press("x");
    expect(commands()).toEqual([
      ["restart_pod", { pod: STATE.pods[1].name, namespace: "shop", context: "kind-dev" }],
    ]);
  });

  it("offers no restart for a pod nothing would start again", () => {
    const bare = { ...STATE.pods[0], name: "debug", controller: null };
    const mirror = { ...STATE.pods[0], name: "kube-apiserver-cp", controller: "Node/cp" };
    fromHost({ type: "panel.state_update", state: { ...STATE, pods: [bare, mirror] } });
    const restarts = [...document.querySelectorAll<HTMLButtonElement>("#rows button.danger")];
    expect(restarts.map((b) => b.disabled)).toEqual([true, true]);
    expect(restarts[1].title).toMatch(/static pod/);
    press("x");
    expect(commands()).toEqual([]);
    expect(sent[0]).toMatchObject({
      type: "rim.ui.notification.show",
      title: "Cannot restart debug",
    });
  });

  it("shows an interval the dropdown does not list", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, intervalSeconds: 10 } });
    expect((document.getElementById("interval") as HTMLSelectElement).value).toBe("10");
  });

  it("colours waiting states apart from failures", () => {
    const pods = ["Terminating", "Init:1/2", "Init:CrashLoopBackOff", "NotReady"].map(
      (status, i) => ({ ...STATE.pods[0], name: `p${i}`, status }),
    );
    fromHost({ type: "panel.state_update", state: { ...STATE, pods } });
    const classes = [...document.querySelectorAll("#rows tr")].map(
      (row) => row.querySelectorAll("td")[1].className,
    );
    expect(classes).toEqual(["status-warn", "status-warn", "status-bad", "status-warn"]);
  });

  it("asks to follow a pod's logs from its row or with l", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, logTailLines: 500 } });
    document.querySelector<HTMLButtonElement>("#rows tr:nth-child(2) button")?.click();
    press("l");
    const args = (pod: string) => ({
      pod,
      namespace: "shop",
      context: "kind-dev",
      tail_lines: 500,
      previous: false,
      follow: true,
    });
    expect(commands()).toEqual([
      ["pod_logs", args(STATE.pods[1].name)],
      ["pod_logs", args(STATE.pods[1].name)],
    ]);
  });

  it("shows the log view as text and changes it through the plugin", () => {
    fromHost({ type: "panel.state_update", state: { ...STATE, logs: LOGS } });
    expect(document.getElementById("table")?.hidden).toBe(true);
    expect(document.getElementById("logs")?.hidden).toBe(false);
    expect(document.getElementById("logs-text")?.textContent).toBe("started\n<b>not bold</b>");
    expect(document.querySelector("#logs-text b")).toBeNull();
    expect(document.getElementById("logs-status")?.textContent).toBe("Following new lines…");

    const container = document.getElementById("logs-container") as HTMLSelectElement;
    container.value = "proxy";
    container.dispatchEvent(new Event("change"));
    const lines = document.getElementById("logs-lines") as HTMLSelectElement;
    lines.value = "1000";
    lines.dispatchEvent(new Event("change"));
    press("p");
    press("f");
    press("Escape");
    const base = { pod: "web-1", namespace: "shop", context: "kind-dev", previous: false };
    expect(commands()).toEqual([
      ["pod_logs", { ...base, tail_lines: 100, follow: true, container: "proxy" }],
      ["pod_logs", { ...base, tail_lines: 1000, follow: true, container: "web" }],
      ["pod_logs", { ...base, tail_lines: 100, previous: true, follow: false, container: "web" }],
      ["stop_logs", {}],
      ["stop_logs", { close: true }],
    ]);
  });

  it("says why logs stopped or failed", () => {
    const view = (logs: Partial<LogView>) =>
      fromHost({ type: "panel.state_update", state: { ...STATE, logs: { ...LOGS, ...logs } } });
    view({ following: false, ended: "The container exited." });
    expect(document.getElementById("logs-status")?.textContent).toBe("The container exited.");
    view({ following: false, dropped: 7 });
    expect(document.getElementById("logs-status")?.textContent).toBe(
      "2 lines · older lines dropped, the last 2 are kept",
    );
    view({ error: { kind: "not_found", message: "No previous run." } });
    expect(document.getElementById("logs-status")?.className).toBe("status-bad");
    view({ previous: true, following: false });
    expect((document.getElementById("logs-follow") as HTMLInputElement).disabled).toBe(true);
  });
});
