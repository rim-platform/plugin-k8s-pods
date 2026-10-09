import { describe, expect, it } from "vitest";

import { classify } from "./kubectl.ts";
import { controllerOf, formatAge, podStatus } from "./pods.ts";

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

  it("shows a pod being deleted as Terminating", () => {
    expect(
      podStatus(pod({ phase: "Running" }, { deletionTimestamp: "2026-10-08T12:00:00Z" })),
    ).toBe("Terminating");
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
  });
});
