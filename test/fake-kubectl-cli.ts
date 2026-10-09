// `bin/kubectl` runs this: the pretend cluster as a program. Every call is
// appended to $FAKE_KUBECTL_LOG when it is set, and deletions persist there too.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { answer, loadCluster, type Scenario } from "./fake-cluster.ts";

const args = process.argv.slice(2);
const log = process.env.FAKE_KUBECTL_LOG;
const cluster = loadCluster();
// Replay earlier deletions, so a pod deleted by one call is gone for the next.
if (log && existsSync(log)) {
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (line.startsWith("delete pod ")) {
      const earlier = line.split(" ").filter((part) => part.length > 0);
      answer(earlier, "ok", cluster);
    }
  }
}
const result = answer(args, (process.env.FAKE_KUBECTL_SCENARIO as Scenario) || "ok", cluster);
if (log) appendFileSync(log, `${args.join(" ")}\n`);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
