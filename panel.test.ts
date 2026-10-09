// @vitest-environment jsdom
// The Pods panel page in a DOM: it renders the state the plugin publishes and
// asks the host to run commands, never running anything itself.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelState } from "./plugin.ts";

const dir = `${import.meta.dirname}/panels/pods`;
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
};

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
});
