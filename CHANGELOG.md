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

### Fixed

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
