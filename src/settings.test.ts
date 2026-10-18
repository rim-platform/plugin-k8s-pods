import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, expandHome, kubectlFlags, parseSettings } from "./settings.ts";

describe("parseSettings", () => {
  it("uses the defaults for an empty set", () => {
    expect(parseSettings({})).toEqual({ settings: DEFAULT_SETTINGS, ignored: [] });
    expect(kubectlFlags(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("reads every setting, trimmed, with ~ as the home folder", () => {
    const { settings, ignored } = parseSettings({
      kubeconfig: " ~/.kube/dev.yaml ",
      kubectl_path: "/opt/kubectl/bin/kubectl",
      default_context: " prod ",
      default_namespace: "kube-system",
      refresh_interval_seconds: 60,
      log_tail_lines: 500,
      unknown_key: true,
    });
    expect(ignored).toEqual([]);
    expect(settings).toEqual({
      kubeconfig: join(homedir(), ".kube/dev.yaml"),
      kubectlPath: "/opt/kubectl/bin/kubectl",
      defaultContext: "prod",
      defaultNamespace: "kube-system",
      intervalSeconds: 60,
      logTailLines: 500,
    });
    expect(kubectlFlags(settings)).toEqual([`--kubeconfig=${join(homedir(), ".kube/dev.yaml")}`]);
  });

  it("treats blank text as unset and values that do not fit as unset, naming them", () => {
    expect(parseSettings({ kubeconfig: "  ", default_context: "" })).toEqual({
      settings: DEFAULT_SETTINGS,
      ignored: [],
    });
    const { settings, ignored } = parseSettings({
      kubeconfig: "/tmp/a\0b",
      kubectl_path: 7,
      default_context: "x".repeat(254),
      default_namespace: "Not_A_Namespace",
      refresh_interval_seconds: 2,
      log_tail_lines: "many",
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(ignored).toEqual([
      "kubeconfig",
      "kubectl_path",
      "default_context",
      "default_namespace",
      "refresh_interval_seconds",
      "log_tail_lines",
    ]);
    expect(parseSettings({ refresh_interval_seconds: 3601, log_tail_lines: 5001 }).ignored).toEqual(
      ["refresh_interval_seconds", "log_tail_lines"],
    );
  });
});

describe("expandHome", () => {
  it("expands only a leading ~", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/k")).toBe(join(homedir(), "k"));
    expect(expandHome("/a/~/k")).toBe("/a/~/k");
    expect(expandHome("~other/k")).toBe("~other/k");
  });
});
