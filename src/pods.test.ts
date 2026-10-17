import { describe, expect, it } from "vitest";

import { classify } from "./kubectl.ts";
import { controllerOf, formatAge, podStatus, summarizePod } from "./pods.ts";

const pod = (status: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  metadata: { name: "p", ...metadata },
  status,
});

describe("podStatus", () => {
  it("prints what kubectl prints", () => {
    expect(podStatus(pod({ phase: "Pending" }))).toBe("Pending");
    expect(podStatus(pod({ phase: "Failed", reason: "Evicted" }))).toBe("Evicted");
    expect(
      podStatus(
        pod({
          phase: "Running",
          containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
        }),
      ),
    ).toBe("ImagePullBackOff");
    expect(
      podStatus(
        pod({
          phase: "Failed",
          containerStatuses: [{ state: { terminated: { exitCode: 137, signal: 9 } } }],
        }),
      ),
    ).toBe("Signal:9");
    expect(
      podStatus(
        pod({
          phase: "Succeeded",
          containerStatuses: [{ state: { terminated: { reason: "Completed", exitCode: 0 } } }],
        }),
      ),
    ).toBe("Completed");
  });

  it("shows init containers before the app containers", () => {
    const inits = (state: Record<string, unknown>) =>
      pod({
        phase: "Pending",
        initContainerStatuses: [{ state: { terminated: { exitCode: 0 } } }, { state }],
      });
    expect(podStatus(inits({ waiting: { reason: "PodInitializing" } }))).toBe("Init:1/2");
    expect(podStatus(inits({ waiting: { reason: "CrashLoopBackOff" } }))).toBe(
      "Init:CrashLoopBackOff",
    );
    expect(podStatus(inits({ terminated: { exitCode: 2 } }))).toBe("Init:ExitCode:2");
  });

  it("counts a started sidecar as ready instead of initializing", () => {
    const runner = (dind: Record<string, unknown>) => ({
      metadata: { name: "runner" },
      spec: {
        initContainers: [{ name: "init-externals" }, { name: "dind", restartPolicy: "Always" }],
        containers: [{ name: "runner" }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Initialized", status: "False" }],
        initContainerStatuses: [
          { name: "init-externals", restartCount: 1, state: { terminated: { exitCode: 0 } } },
          { name: "dind", restartCount: 2, ...dind },
        ],
        containerStatuses: [
          { name: "runner", ready: true, restartCount: 3, state: { running: {} } },
        ],
      },
    });
    const now = new Date("2026-10-17T12:00:00Z");
    const columns = (dind: Record<string, unknown>) => {
      const { status, ready, restarts } = summarizePod(runner(dind), now);
      return { status, ready, restarts };
    };

    expect(columns({ started: true, ready: true, state: { running: {} } })).toEqual({
      status: "Running",
      ready: "2/2",
      restarts: 5,
    });
    expect(columns({ started: true, ready: false, state: { running: {} } })).toEqual({
      status: "Running",
      ready: "1/2",
      restarts: 5,
    });
    expect(columns({ started: false, ready: false, state: { running: {} } })).toEqual({
      status: "Init:1/2",
      ready: "0/2",
      restarts: 3,
    });
  });

  it("shows a finished pod with a running container as NotReady until it is ready", () => {
    const finishing = (conditions: unknown[]) =>
      pod({
        phase: "Running",
        conditions,
        containerStatuses: [
          { ready: true, state: { running: {} } },
          { state: { terminated: { reason: "Completed", exitCode: 0 } } },
        ],
      });
    expect(podStatus(finishing([{ type: "Ready", status: "True" }]))).toBe("Running");
    expect(podStatus(finishing([{ type: "Ready", status: "False" }]))).toBe("NotReady");
  });

  it("shows a gated pod as SchedulingGated", () => {
    expect(
      podStatus(
        pod({
          phase: "Pending",
          conditions: [{ type: "PodScheduled", status: "False", reason: "SchedulingGated" }],
        }),
      ),
    ).toBe("SchedulingGated");
  });

  it("shows a pod being deleted as Terminating", () => {
    expect(
      podStatus(pod({ phase: "Running" }, { deletionTimestamp: "2026-10-08T12:00:00Z" })),
    ).toBe("Terminating");
    expect(
      podStatus(pod({ phase: "Succeeded" }, { deletionTimestamp: "2026-10-08T12:00:00Z" })),
    ).toBe("Succeeded");
  });
});

describe("controllerOf", () => {
  it("names the controlling owner only", () => {
    const owners = (ownerReferences: unknown[]) => ({ metadata: { ownerReferences } });
    expect(controllerOf(owners([{ kind: "StatefulSet", name: "db", controller: true }]))).toBe(
      "StatefulSet/db",
    );
    expect(controllerOf(owners([{ kind: "ConfigMap", name: "x" }]))).toBeNull();
    expect(controllerOf({ metadata: {} })).toBeNull();
  });
});

describe("formatAge", () => {
  it("rounds down like kubectl", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const ago = (seconds: number) => formatAge(new Date(now.getTime() - seconds * 1000), now);
    expect([ago(5), ago(119), ago(120), ago(7199), ago(7200), ago(172_799), ago(172_800)]).toEqual([
      "5s",
      "119s",
      "2m",
      "119m",
      "2h",
      "47h",
      "2d",
    ]);
    expect(ago(800 * 86_400)).toBe("2y");
    expect(ago(-30)).toBe("0s");
  });
});

describe("classify", () => {
  it.each([
    [
      'Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods"',
      "forbidden",
    ],
    ["error: You must be logged in to the server (Unauthorized)", "unauthorized"],
    ['error: context "staging" does not exist', "context_missing"],
    ['error: no context exists with the name: "staging"', "context_missing"],
    ["error: no configuration has been provided", "no_kubeconfig"],
    [
      "Unable to connect to the server: dial tcp: lookup api.example on 1.1.1.1: no such host",
      "unreachable",
    ],
    [
      "The connection to the server localhost:8080 was refused - did you specify the right host or port?",
      "unreachable",
    ],
    ['Error from server (NotFound): pods "x" not found', "not_found"],
    ["error: something else", "failed"],
  ])("%s", (stderr, kind) => {
    expect(classify(stderr).kind).toBe(kind);
  });

  it("keeps the first error line without the error prefix", () => {
    expect(classify('I1008 warning\nerror: context "a" does not exist\nmore').detail).toBe(
      'context "a" does not exist',
    );
    expect(classify('Error from server (NotFound): pods "web" not found').detail).toBe(
      'pods "web" not found',
    );
  });
});
