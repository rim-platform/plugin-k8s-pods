import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KubeError } from "./kubectl.ts";
import {
  cleanLine,
  LineBuffer,
  MAX_LOG_LINES,
  MAX_LOG_VIEW_BYTES,
  systemFollow,
  type FollowSink,
} from "./logs.ts";

const FAKE_KUBECTL = join(import.meta.dirname, "test/bin/kubectl");

describe("cleanLine", () => {
  it("keeps the text and drops what a terminal would interpret", () => {
    expect(cleanLine("\x1b[1;31mERROR\x1b[0m boom")).toBe("ERROR boom");
    expect(cleanLine("\x1b]0;title\x07after")).toBe("after");
    expect(cleanLine("tab\tkept\x00\x08bell\x07")).toBe("tab\tkeptbell");
    expect(cleanLine("x".repeat(5000))).toHaveLength(4097);
  });
});

describe("LineBuffer", () => {
  it("keeps a line once its newline arrives, and the last one at the end", () => {
    const buffer = new LineBuffer();
    buffer.push("a\r\nb");
    expect(buffer.lines).toEqual(["a"]);
    buffer.push("c\nd");
    buffer.end();
    expect(buffer.lines).toEqual(["a", "bc", "d"]);
  });

  it("drops the oldest lines past its line and byte limits", () => {
    const many = new LineBuffer();
    many.push("x\n".repeat(MAX_LOG_LINES + 3));
    expect(many.lines).toHaveLength(MAX_LOG_LINES);
    expect(many.dropped).toBe(3);

    const wide = new LineBuffer();
    const line = "y".repeat(4000);
    wide.push(`${line}\n`.repeat(100));
    expect(wide.lines.length * (line.length + 1)).toBeLessThanOrEqual(MAX_LOG_VIEW_BYTES);
    expect(wide.dropped).toBe(100 - wide.lines.length);
  });
});

describe("systemFollow", () => {
  function collect() {
    const chunks: string[] = [];
    let resolve: (error: KubeError | null) => void = () => {};
    const ended = new Promise<KubeError | null>((done) => (resolve = done));
    const sink: FollowSink = { onData: (chunk) => chunks.push(chunk), onEnd: resolve };
    return { chunks, ended, sink };
  }

  it("streams kubectl's output and reports a clean exit", async () => {
    const out = collect();
    systemFollow(FAKE_KUBECTL)(
      ["logs", "worker-5d8b-fghij", "--container=sidecar", "--follow", "--namespace=shop"],
      out.sink,
    );
    expect(await out.ended).toBeNull();
    expect(out.chunks.join("")).toBe("proxy ready\n");
  });

  it("classifies kubectl's error when the stream fails", async () => {
    const out = collect();
    systemFollow(FAKE_KUBECTL)(["logs", "gone", "--follow", "--namespace=shop"], out.sink);
    expect(await out.ended).toMatchObject({ kind: "not_found" });

    const missing = collect();
    systemFollow("/nonexistent/kubectl")(["logs"], missing.sink);
    expect(await missing.ended).toMatchObject({ kind: "kubectl_missing" });
  });

  it("reports nothing once stopped", async () => {
    let ended = false;
    const stop = systemFollow("sleep")(["5"], {
      onData: () => {},
      onEnd: () => (ended = true),
    });
    stop();
    await new Promise((done) => setTimeout(done, 100));
    expect(ended).toBe(false);
  });
});
