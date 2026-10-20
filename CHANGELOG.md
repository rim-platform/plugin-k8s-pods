# Changelog

What changes between releases of the Kubernetes Pods plugin, for the people who use it and the
workspaces that recommend it. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); a release is the tag `v<version>`,
the version in `rim-plugin.json` and in `package.json`.

## How entries are written

- A pull request that changes what a user or a workspace sees adds its line under `Unreleased`
  in the same pull request. Refactors, tests and internal documentation do not.
- Each line goes under one heading: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or
  `Security`. It says what changed for the reader, not how it was built.
- A change to the plugin's permissions or commands names them: a new permission makes every
  install ask again.
- At release time `Unreleased` becomes `## [<version>] - <YYYY-MM-DD>` and a new empty
  `Unreleased` starts above it.

## [Unreleased]

### Added

- **Pods: Show logs** (`pod_logs`) and a **Logs** button on each pod (key <kbd>l</kbd>): the last
  lines of a container, its previous run, or new lines followed as they arrive, 100 lines at
  first and up to 5000. The AI agent may read logs only after you allow this command in
  Settings → Plugin AI; it never follows them. **Pods: Stop following logs** (`stop_logs`)
  stops following and closes the view.
- Settings, in the plugin's settings form (**Settings** on its row in Settings → Plugins, or
  **Plugin settings** in the panel's header): the kubeconfig file and the kubectl program to
  use, the context and namespace the panel opens on, how often it refreshes (5 to 3600
  seconds, 15 by default) and how many log lines a log view starts with (100 by default). A
  saved change applies at once. The settings change the plugin's manifest, so RIM asks once
  more, in Settings → Plugin AI, before the AI agent may use the plugin's commands.

### Fixed

- A namespace or context picked while the first listing still ran is kept instead of being
  replaced by the kubeconfig's.
- The selected pod stays selected when a refresh reorders the list, so <kbd>x</kbd> restarts
  the pod you picked.
- **Restart** is greyed out for pods without a controller and for static pods, which it could
  not restart.
- A manual refresh lists namespaces created since the panel opened.
- Waiting states (`Terminating`, `PodInitializing`, `NotReady`, …) show amber instead of red,
  and a refresh interval set by command shows in the dropdown.
- Pods with sidecar containers (init containers with `restartPolicy: Always`, such as the
  `dind` container of a GitHub Actions runner) show the status, ready count and restarts that
  `kubectl get pods` shows, instead of staying at `Init:1/2` with the sidecar left out of
  the ready count.

## [0.0.1] - 2026-10-16

### Added

- The Kubernetes Pods plugin, first released from its own repository. It lists the pods of a
  namespace in its **Pods** panel with status, restarts and age, and restarts a pod with a
  controller after you confirm, with the commands **Pods: Refresh**, **Pods: Filter** and
  **Pods: Restart pod**. It runs `kubectl` on your device with your own kubeconfig.
- The repository holds the built plugin at its root (`rim-plugin.json`, `main.mjs` with the
  SDK inside, and `panels/`), so the desktop installs it from its git URL with nothing to
  `npm install`; each release attaches a `.rimbundle` for Install from link.

[Unreleased]: https://github.com/rim-platform/plugin-k8s-pods/compare/v0.0.1...master
[0.0.1]: https://github.com/rim-platform/plugin-k8s-pods/releases/tag/v0.0.1
