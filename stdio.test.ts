// The bundled plugin as the host runs it: one file plus its panel, started
// through its #! line, speaking frames over real stdin and stdout, with a fake
// kubectl standing in for the user's.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@rim-platform/plugin-sdk";

const PLUGIN_DIR = import.meta.dirname;
const BUNDLER = join(PLUGIN_DIR, "../../sdk/plugin-sdk/scripts/bundle-plugin.mjs");
const FAKE_KUBECTL = join(PLUGIN_DIR, "test/bin/kubectl");
const PRINCIPAL = {
  principalId: "rimp0_PWcag22GowE59KogGTaUReeoF_q4E5EVi28q83uaGBU",
  displayName: "Jakub",
};

type Frame = Record<string, unknown>;

function launch(pluginDir: string) {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "rim-plugin.json"), "utf8"));
  const child = spawn(join(pluginDir, manifest.entrypoint), [], {
    cwd: pluginDir,
    env: { ...process.env, RIM_KUBECTL: FAKE_KUBECTL },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const decoder = new FrameDecoder();
  const waiting = new Map<unknown, (frame: Frame) => void>();
  const send = (frame: Frame) => child.stdin.write(encodeFrame(frame));
  child.stdout.on("data", (chunk: Uint8Array) => {
    for (const decoded of decoder.push(chunk)) {
      if (!decoded.ok) throw new Error(decoded.error);
      const frame = decoded.value as Frame;
      if (frame.method === "rim.log") continue;
      if (typeof frame.method === "string") {
        // A host that did not grant ui.panel refuses the panel update.
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: "not granted" } });
        continue;
      }
      waiting.get(frame.id)?.(frame);
    }
  });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  const ask = (frame: Frame) =>
    new Promise<Frame>((done) => {
      waiting.set(frame.id, done);
      send(frame);
    });
  return { manifest, send, ask, exited };
}

function execute(id: number, commandId: string, args: Frame, confirmed: boolean): Frame {
  return {
    jsonrpc: "2.0",
    id,
    method: "rim.command.execute",
    params: { commandId, args, invoker: PRINCIPAL, initiator: "user", confirmed },
  };
}

describe("Kubernetes Pods plugin, bundled", () => {
  it("ships its panel and speaks v1 over stdio", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "rim-k8s-")), "chat.rim.k8s-pods");
    execFileSync(process.execPath, [BUNDLER, PLUGIN_DIR, outDir]);
    expect(existsSync(join(outDir, "panels/pods/index.html"))).toBe(true);
    expect(existsSync(join(outDir, "panels/pods/app.js"))).toBe(true);
    // The bundle carries what the plugin runs, not its tests or fakes.
    expect(existsSync(join(outDir, "test"))).toBe(false);

    const plugin = launch(outDir);
    expect(plugin.manifest.entrypoint).toBe("main.mjs");
    const handshake = await plugin.ask({
      jsonrpc: "2.0",
      id: 1,
      method: "rim.handshake",
      params: {
        protocolVersion: 1,
        supportedVersions: [1],
        pluginId: "chat.rim.k8s-pods",
        hostVersion: "0.1.0",
        grantedCapabilities: [],
        principal: PRINCIPAL,
      },
    });
    expect(handshake.result).toEqual({
      accepted: true,
      protocolVersion: 1,
      pluginId: "chat.rim.k8s-pods",
    });

    const refreshed = await plugin.ask(execute(2, "refresh", {}, false));
    expect(refreshed.result).toMatchObject({ message: "3 pods in shop (kind-dev)" });

    const refused = await plugin.ask(execute(3, "restart_pod", { pod: "web-7f9c-abcde" }, false));
    expect(refused.error).toMatchObject({ data: { reason: "confirmation_required" } });

    plugin.send({ jsonrpc: "2.0", method: "rim.shutdown" });
    expect(await plugin.exited).toBe(0);
  }, 30_000);
});
