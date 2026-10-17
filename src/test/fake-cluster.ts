// A pretend cluster for the k8s-pods tests: answers the kubectl calls the
// plugin makes the way kubectl would, from cluster.json. `bin/kubectl` runs
// it as a real program for the stdio and Rust conformance tests.
import { readFileSync } from "node:fs";

import { classify, type Kubectl } from "../kubectl.ts";

/** How the pretend cluster misbehaves, from `FAKE_KUBECTL_SCENARIO`. */
export type Scenario =
  "ok" | "no-config" | "unreachable" | "unauthorized" | "forbidden" | "namespaces-forbidden";

export interface Answer {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

type Json = Record<string, unknown>;

export function loadCluster(): Json {
  return JSON.parse(readFileSync(new URL("./cluster.json", import.meta.url), "utf8")) as Json;
}

/** Answer one kubectl command line. `cluster` is changed by `delete`. */
export function answer(args: readonly string[], scenario: Scenario, cluster: Json): Answer {
  const ok = (value: unknown): Answer => ({
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
    code: 0,
  });
  const fail = (stderr: string): Answer => ({ stdout: "", stderr, code: 1 });
  const flag = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const config = cluster.config as Json;
  const contexts = (config.contexts as Json[]).map((c) => c.name as string);

  if (args[0] === "config" && args[1] === "view") {
    if (scenario === "no-config") {
      return ok({
        kind: "Config",
        apiVersion: "v1",
        clusters: null,
        contexts: null,
        "current-context": "",
      });
    }
    return ok(config);
  }

  const context = flag("context") ?? (config["current-context"] as string);
  if (!contexts.includes(context)) return fail(`error: context "${context}" does not exist`);
  if (scenario === "no-config") {
    return fail(
      "error: no configuration has been provided, try setting KUBERNETES_MASTER environment variable",
    );
  }
  if (scenario === "unreachable") {
    return fail("Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout");
  }
  if (scenario === "unauthorized") {
    return fail("error: You must be logged in to the server (Unauthorized)");
  }

  const namespace = flag("namespace") ?? "default";
  const pods = ((cluster.pods as Json)[namespace] as Json | undefined) ?? {
    kind: "List",
    items: [],
  };
  const items = pods.items as Json[];
  const find = (name: string) => items.findIndex((p) => (p.metadata as Json).name === name);
  const forbidden = (resource: string, scope: string) =>
    fail(
      `Error from server (Forbidden): ${resource} is forbidden: User "dev" cannot list resource "${resource}" in API group "" ${scope}`,
    );

  if (args[0] === "get" && args[1] === "namespaces") {
    if (scenario === "forbidden" || scenario === "namespaces-forbidden") {
      return forbidden("namespaces", "at the cluster scope");
    }
    return ok(cluster.namespaces);
  }
  if (args[0] === "get" && args[1] === "pods") {
    if (scenario === "forbidden") return forbidden("pods", `in the namespace "${namespace}"`);
    return ok(pods);
  }
  if (args[0] === "get" && args[1] === "pod") {
    const index = find(args[2]);
    if (index < 0) return fail(`Error from server (NotFound): pods "${args[2]}" not found`);
    return ok(items[index]);
  }
  if (args[0] === "logs") {
    const pod = args[1];
    if (find(pod) < 0) return fail(`Error from server (NotFound): pods "${pod}" not found`);
    const container = flag("container") ?? "";
    const previous = args.includes("--previous");
    const logs = cluster.logs as Record<string, string>;
    const text = logs[`${namespace}/${pod}/${container}${previous ? ":previous" : ""}`];
    if (text === undefined) {
      return previous
        ? fail(
            `Error from server (BadRequest): previous terminated container "${container}" in pod "${pod}" not found`,
          )
        : ok("");
    }
    const tail = Number(flag("tail") ?? "-1");
    const lines = text.split("\n").slice(0, -1);
    return ok(
      lines
        .slice(tail < 0 ? 0 : -tail)
        .map((line) => `${line}\n`)
        .join(""),
    );
  }
  if (args[0] === "delete" && args[1] === "pod") {
    const index = find(args[2]);
    if (index < 0) return fail(`Error from server (NotFound): pods "${args[2]}" not found`);
    items.splice(index, 1);
    return ok(`pod "${args[2]}" deleted\n`);
  }
  return fail(`error: unknown command "${args.join(" ")}" for "kubectl"`);
}

/** A {@link Kubectl} backed by the pretend cluster, recording every call. */
export function fakeKubectl(scenario: Scenario = "ok") {
  const cluster = loadCluster();
  const calls: string[][] = [];
  const state = { scenario };
  const kubectl: Kubectl = async (args) => {
    calls.push([...args]);
    const result = answer(args, state.scenario, cluster);
    if (result.code !== 0) throw classify(result.stderr);
    return result.stdout;
  };
  return { kubectl, calls, cluster, state };
}
