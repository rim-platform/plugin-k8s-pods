// The bundled plugin as the host runs it: one file plus its panel, started
// through its #! line, speaking frames over real stdin and stdout, with a fake
// kubectl standing in for the user's.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@rim-platform/plugin-sdk";

const PLUGIN_DIR = join(import.meta.dirname, "..");
const FAKE_KUBECTL = join(import.meta.dirname, "test/bin/kubectl");

/** The installed SDK's `rim-plugin-bundle`, as `npx rim-plugin-bundle` runs it. */
function bundlerPath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    "@rim-platform/plugin-sdk/package.json",
  );
  const { bin } = JSON.parse(readFileSync(packageJson, "utf8"));
  return join(dirname(packageJson), bin["rim-plugin-bundle"]);
}
const PRINCIPAL = {
  principalId: "rimp0_PWcag22GowE59KogGTaUReeoF_q4E5EVi28q83uaGBU",
  displayName: "Jakub",
};

type Frame = Record<string, unknown>;

/** Bundle the plugin as a release does, into a fresh folder. */
function bundle(): string {
  const outDir = join(mkdtempSync(join(tmpdir(), "rim-k8s-")), "chat.rim.k8s-pods");
  execFileSync(process.execPath, [bundlerPath(), "--entry", "src/main.ts", PLUGIN_DIR, outDir]);
  return outDir;
}

/**
 * Start the bundled plugin with the fake kubectl as `$RIM_KUBECTL`, or `kubectl`
 * instead. A host with `settings` answers `rim.settings.get` with them.
 */
function launch(
  pluginDir: string,
  { kubectl = FAKE_KUBECTL, settings }: { kubectl?: string; settings?: Frame } = {},
) {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "rim-plugin.json"), "utf8"));
  const child = spawn(join(pluginDir, manifest.entrypoint), [], {
    cwd: pluginDir,
    env: { ...process.env, RIM_KUBECTL: kubectl },
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
      if (frame.method === "rim.settings.get" && settings) {
        send({ jsonrpc: "2.0", id: frame.id, result: { values: settings } });
        continue;
      }
      if (typeof frame.method === "string") {
        // A host that did not grant ui.panel refuses the panel update, and the
        // settings read too when it has none.
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

const HANDSHAKE: Frame = {
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
};

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
    const outDir = bundle();
    // The bundle carries what the plugin runs, not its sources, tests or fakes.
    expect(readdirSync(outDir, { recursive: true }).sort()).toEqual([
      "main.mjs",
      "panels",
      "panels/pods",
      "panels/pods/app.js",
      "panels/pods/index.html",
      "rim-plugin.json",
    ]);

    const plugin = launch(outDir);
    expect(plugin.manifest.entrypoint).toBe("main.mjs");
    const handshake = await plugin.ask(HANDSHAKE);
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

  it("runs the kubectl its settings name in place of $RIM_KUBECTL", async () => {
    const outDir = bundle();
    const missing = launch(outDir, { kubectl: join(outDir, "no-kubectl") });
    await missing.ask(HANDSHAKE);
    const notFound = await missing.ask(execute(2, "refresh", {}, false));
    expect(notFound.error).toMatchObject({ data: { reason: "kubectl_missing" } });
    missing.send({ jsonrpc: "2.0", method: "rim.shutdown" });
    expect(await missing.exited).toBe(0);

    const plugin = launch(outDir, {
      kubectl: join(outDir, "no-kubectl"),
      settings: { kubectl_path: FAKE_KUBECTL },
    });
    await plugin.ask(HANDSHAKE);
    const refreshed = await plugin.ask(execute(2, "refresh", {}, false));
    expect(refreshed.result).toMatchObject({ message: "3 pods in shop (kind-dev)" });
    plugin.send({ jsonrpc: "2.0", method: "rim.shutdown" });
    expect(await plugin.exited).toBe(0);
  }, 30_000);
});
