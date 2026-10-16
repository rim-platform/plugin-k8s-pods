#!/usr/bin/env node
// Entry point of the plugin. Node 22.18 or newer runs this TypeScript file as
// is; `npm run build` bundles it, with the SDK inside, into the main.mjs at
// the repository root, which the host starts.
import { createPlugin } from "./plugin.ts";

await createPlugin().run();
