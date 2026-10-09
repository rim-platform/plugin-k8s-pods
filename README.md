# Kubernetes Pods plugin

Lists the pods of a Kubernetes namespace in a RIM panel, with status, restarts and age,
and restarts a pod after you confirm. Built on the
[TypeScript SDK](../../sdk/plugin-sdk/README.md).

## Your credentials stay on this device

The plugin runs `kubectl` on your machine with your own kubeconfig. It never reads your
credentials itself: it only sees what `kubectl` prints (pod lists, the names of your
contexts) and its error text. Nothing from your cluster or your kubeconfig is sent to the
RIM server or to the AI model provider. The AI agent sees a pod listing only when you
let it call the plugin's commands (Settings → Plugins → AI permissions).

## What it does

| Command                               | Kind      | What it does                                                                                                  |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| **Pods: Refresh** (`refresh`)         | safe      | Lists the pods again. Suggested keybind: <kbd>Ctrl+Alt+P</kbd>.                                               |
| **Pods: Filter** (`filter`)           | safe      | Picks the context, namespace, name filter or refresh interval. With no arguments it clears the name filter.   |
| **Pods: Restart pod** (`restart_pod`) | dangerous | Deletes a pod so its controller starts a fresh one. RIM asks you to confirm; the AI agent can only propose it. |

The **Pods** panel lists the pods and refreshes every 15 seconds (5 s to 5 min, or off).
Pick the context and namespace at the top. Keys in the panel: <kbd>j</kbd>/<kbd>k</kbd>
move, <kbd>r</kbd> refreshes, <kbd>/</kbd> filters, <kbd>x</kbd> restarts the selected
pod (after the confirmation).

A pod with no controller (no ReplicaSet, StatefulSet, Job, …) is never restarted: deleting
it would remove it for good. Neither is a static pod, which the kubelet runs from a file on
its node: deleting it through the API would restart nothing.

When something is wrong the panel says so: no kubectl or no kubeconfig, a cluster it
cannot reach, credentials the cluster refused, or a namespace your account may not read.
If your account may not list namespaces, type the namespace instead.

## Install

1. Bundle it: `npm run plugin:bundle -- plugins/k8s-pods`. This writes
   `plugins/k8s-pods/dist/chat.rim.k8s-pods/` (one `main.mjs`, the manifest and the panel).
2. In RIM, open **Settings → Plugins → Install from local folder** and pick that folder.
   RIM shows what the plugin does and asks for its permissions: allow **Render UI Panels**
   for the pods list and **Show Notifications** for restart results.
3. Turn the plugin on. Open **Pods** from the side rail, or run **Pods: Refresh** from the
   command palette.

It needs Node.js 22 or newer and `kubectl` on this device. RIM finds `kubectl` on your
`PATH` and in the usual install folders (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, …). To use another binary, set `RIM_KUBECTL` to its path before starting
RIM. `kubectl` reads `KUBECONFIG` and `~/.kube/config` as usual.

## Develop

```
kubectl.ts        runs kubectl and sorts its errors into kinds
pods.ts           turns pod JSON into rows, the way kubectl get pods does
plugin.ts         the commands, the refresh loop and the panel state
panels/pods/      the panel page (plain HTML and JS, rendered with textContent only)
test/             a fake cluster and a fake kubectl for the tests
```

`npm test` runs the unit tests, the panel tests (in jsdom) and `stdio.test.ts`, which
bundles the plugin and talks to it over real stdin and stdout. The host's conformance tests
in `src-tauri` (`cargo test k8s_pods`) start it from source the same way and drive it
through the plugin host, its panel included.
