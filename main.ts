#!/usr/bin/env node
// Entry point the RIM host starts. Node 22.18 or newer runs this TypeScript
// file as is; `npm run plugin:bundle -- plugins/k8s-pods` makes a single
// JavaScript file to install instead.
import { createPlugin } from "./plugin.ts";

await createPlugin().run();
