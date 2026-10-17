// Container logs for the panel: a bounded buffer of lines, and `kubectl logs -f`
// run as a long-lived process whose output arrives in chunks.
import { spawn } from "node:child_process";

import { classify, findKubectl, KubeError } from "./kubectl.ts";

/** Lines a log view keeps; older ones are dropped as new ones arrive. */
export const MAX_LOG_LINES = 5000;
/** Bytes a log view keeps, so it fits the host's panel state next to the pods. */
export const MAX_LOG_VIEW_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 4096;
const MAX_STDERR_BYTES = 4096;

/** Escape sequences (colours, cursor moves, titles) a terminal would interpret. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** One log line as plain text: no escape sequences or control characters, at most 4096 characters. */
export function cleanLine(line: string): string {
  const plain = line.replace(ESCAPES, "").replace(CONTROL, "");
  return plain.length > MAX_LINE_LENGTH ? `${plain.slice(0, MAX_LINE_LENGTH)}…` : plain;
}

/** The newest lines of a log, at most {@link MAX_LOG_LINES} and {@link MAX_LOG_VIEW_BYTES}. */
export class LineBuffer {
  private kept: string[] = [];
  private bytes = 0;
  private partial = "";
  /** Lines dropped from the start to stay within the limits. */
  dropped = 0;

  /** Add output as it arrives; a line is kept once its newline has arrived. */
  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const part of parts) this.add(part);
  }

  /** Keep the last unterminated line, as when the output ends. */
  end(): void {
    if (this.partial.length > 0) this.add(this.partial);
    this.partial = "";
  }

  get lines(): readonly string[] {
    return this.kept;
  }

  private add(raw: string): void {
    const line = cleanLine(raw);
    this.kept.push(line);
    this.bytes += line.length + 1;
    while (this.kept.length > MAX_LOG_LINES || this.bytes > MAX_LOG_VIEW_BYTES) {
      this.bytes -= (this.kept.shift() as string).length + 1;
      this.dropped++;
    }
  }
}

/** Where a followed log's output goes. */
export interface FollowSink {
  onData(chunk: string): void;
  /** The stream ended by itself: `null` when kubectl exited cleanly. */
  onEnd(error: KubeError | null): void;
}

/** Runs kubectl with `args` until it exits or the returned function stops it. */
export type Follow = (args: readonly string[], sink: FollowSink) => () => void;

/** `kubectl logs -f` on this device. Stopping it kills kubectl and reports nothing. */
export function systemFollow(binary: string = findKubectl()): Follow {
  return (args, sink) => {
    let stopped = false;
    let stderr = "";
    const child = spawn(binary, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!stopped) sink.onData(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });
    const end = (error: KubeError | null) => {
      if (stopped) return;
      stopped = true;
      sink.onEnd(error);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      end(
        error.code === "ENOENT"
          ? new KubeError("kubectl_missing", `${binary} was not found`)
          : new KubeError("failed", error.message),
      );
    });
    child.on("close", (code) => end(code === 0 ? null : classify(stderr || `exit code ${code}`)));
    return () => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
  };
}
