# Kubernetes Pods

A [RIM](https://github.com/rim-platform) plugin that lists the pods of a Kubernetes namespace in
a panel, with status, restarts and age, shows and follows a container's logs, and restarts a pod
after you confirm. It is a
`DesktopLocalProcess` plugin built on
[`@rim-platform/plugin-sdk`](https://www.npmjs.com/package/@rim-platform/plugin-sdk): the RIM
desktop app runs it as a program on your computer.

## Your credentials stay on this device

The plugin runs `kubectl` on your machine with your own kubeconfig. It never reads your
credentials itself: it only sees what `kubectl` prints (pod lists, logs, the names of your
contexts) and its error text. Nothing from your cluster or your kubeconfig is sent to the RIM
server or to the AI model provider. The AI agent sees a pod listing only when you let it call the
plugin's commands (Settings → Plugins → AI permissions), and pod logs only when you allow
**Pods: Show logs** there as well: logs can hold secrets and personal data, so it starts off.

## What it asks for

RIM shows the plugin as one that "Runs as a program on this computer with your account's
access. It is not sandboxed: it can read your files and use the network whatever you approve
below. Install it only if you trust its author." It asks for two permissions:

- **Render UI Panels** (`ui.panel`), to render the pods list in its **Pods** panel.
- **Show Notifications** (`ui.notify`), to show desktop notifications with the result of a
  restart.

## What it does

| Command                               | Kind      | What it does                                                                                                   |
| ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| **Pods: Refresh** (`refresh`)         | safe      | Lists the pods again. Suggested keybind: <kbd>Ctrl+Alt+P</kbd>.                                                |
| **Pods: Filter** (`filter`)           | safe      | Picks the context, namespace, name filter or refresh interval. With no arguments it clears the name filter.    |
| **Pods: Restart pod** (`restart_pod`) | dangerous | Deletes a pod so its controller starts a fresh one. RIM asks you to confirm; the AI agent can only propose it. |
| **Pods: Show logs** (`pod_logs`) | safe | Shows a container's last lines (100 at first, up to 5000), from its current or previous run, and follows new ones in the panel. The AI agent reads them once, never follows, and only if you allow it. |
| **Pods: Stop following logs** (`stop_logs`) | safe | Stops following; with `close`, closes the log view. |

The **Pods** panel lists the pods and refreshes every 15 seconds (5 s to 5 min, or off). Pick
the context and namespace at the top. Keys in the panel: <kbd>j</kbd>/<kbd>k</kbd> move,
<kbd>r</kbd> refreshes, <kbd>/</kbd> filters, <kbd>l</kbd> opens the selected pod's logs,
<kbd>x</kbd> restarts the selected pod (after the confirmation).

**Logs** on a pod's row opens its log view and follows new lines as the container prints them.
Pick the container (init containers and sidecars too), how many of the last lines to start with
(the plugin keeps your choice until RIM restarts), or the previous run, e.g. after a crash. In
the log view <kbd>f</kbd> turns following on or off, <kbd>p</kbd> switches to the previous run,
<kbd>r</kbd> reads again and <kbd>Esc</kbd> goes back to the pods. The view keeps the newest 5000
lines (256 KiB) and shows them as plain text, without terminal colours.

A pod with no controller (no ReplicaSet, StatefulSet, Job, …) is never restarted: deleting it
would remove it for good. Neither is a static pod, which the kubelet runs from a file on its
node: deleting it through the API would restart nothing. The panel greys out **Restart** for
both.

When something is wrong the panel says so: no kubectl or no kubeconfig, a cluster it cannot
reach, credentials the cluster refused, or a namespace your account may not read. If your
account may not list namespaces, type the namespace instead.

## Install

It needs the RIM desktop app, Node.js 22 or newer and `kubectl` on this device. RIM finds
`kubectl` on your `PATH` and in the usual install folders (`/opt/homebrew/bin`,
`/usr/local/bin`, `~/.local/bin`, …). To use another binary, set `RIM_KUBECTL` to its path
before starting RIM. `kubectl` reads `KUBECONFIG` and `~/.kube/config` as usual.

Each way ends the same: RIM shows what the plugin does and asks for its permissions; allow
them, turn the plugin on, and open **Pods** from the side rail or run **Pods: Refresh** from
the command palette.

- **Install from git URL**: Settings → Plugins → Install from git URL, with
  `https://github.com/rim-platform/plugin-k8s-pods.git`. The desktop runs the committed
  `main.mjs`, which has the SDK inside; the plugin has no runtime dependencies, so there is
  nothing to `npm install`.
- **Install from link**: Settings → Plugins → Install from link, with the link a
  [release](https://github.com/rim-platform/plugin-k8s-pods/releases) gives:
  `https://github.com/rim-platform/plugin-k8s-pods/releases/download/v<version>/chat.rim.k8s-pods-<version>.rimbundle#sha256=<hash>`.
  The app checks that the bundle hashes to the value after `#sha256=` before it installs
  anything. The web app refuses a plugin that runs as a local program, so install it on the
  desktop. Install from link with a GitHub release asset works on the desktop once it fetches
  links natively (a rim-ui issue).
- **Workspace registry**: when a workspace recommends or requires the plugin, the desktop's
  command palette offers it under "Workspace plugins" with its publisher's signature, and a
  required one is offered when the workspace opens. The app verifies the signed statement
  before it installs the exact version the workspace pinned.

## Develop

Node 22.18 or newer.

```sh
npm ci                 # install the SDK, esbuild and the test tools
npm test               # unit tests, the panel in jsdom, and the bundled plugin over real stdio
npm run typecheck      # tsc with the strict settings plugins use
npm run lint
npm run format:check
npm run build          # bundle src/main.ts into main.mjs; commit the result
npm run check          # main.mjs and panels/ match a fresh build, as CI checks
npm run bundle         # dist/chat.rim.k8s-pods-<version>.rimbundle, and its sha256
node src/main.ts       # run the plugin from source, as the host would, over stdio
```

```text
rim-plugin.json    the manifest the app installs by
main.mjs           the built plugin, committed; npm run build writes it
panels/pods/       the panel page (plain HTML and JS, rendered with textContent only)
src/main.ts        the entry the build starts from
src/plugin.ts      the commands, the refresh loop and the panel state
src/kubectl.ts     runs kubectl and sorts its errors into kinds
src/pods.ts        turns pod JSON into rows, the way kubectl get pods does
src/test/          a fake cluster and a fake kubectl for the tests
```

`src/stdio.test.ts` bundles the plugin with the installed `rim-plugin-bundle`, starts it
through its `#!` line and talks to it over real stdin and stdout, with the fake kubectl
standing in for yours.

A release is a tag `v<version>` matching the version in `rim-plugin.json` and `package.json`,
with a section for it in `CHANGELOG.md`. `CONTRIBUTING.md` has the rules for a pull request.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`.
