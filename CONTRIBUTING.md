# Contributing

Anyone can contribute. Open a pull request against `master` and the maintainers will review it.

This repository is licensed under the Apache License 2.0 (see `LICENSE`), and contributions are
accepted under the same license.

Everyone taking part follows the code of conduct in `CODE_OF_CONDUCT.md`. A security
vulnerability is never reported in a public issue or pull request: `SECURITY.md` says how to
report it privately.

## A pull request

- Change the sources in `src/` and the panel in `panels/`, then run `npm run build` and commit
  the rebuilt `main.mjs` with them: Install from git URL runs the committed file, and CI fails
  when it is not a fresh build (`npm run check`).
- Run `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`, and say in
  the pull request what you ran.
- A change people notice adds its line under `Unreleased` in `CHANGELOG.md`.
- Comments say what the code is and does, briefly. Commit messages have a plain imperative
  first line of at most 72 characters and a body that says why.

## Who can merge and release

- **Every change is a pull request.** Nobody pushes to `master` directly, the maintainer
  included.
- **CI must pass.** The `Check` job of `.github/workflows/ci.yaml` is a required check.
- **The maintainer merges.** `.github/CODEOWNERS` names the maintainer, @dvorakj31, as the
  reviewer of every path, and only the maintainer has write access. Everyone else works from a
  fork.
- **The maintainer releases.** Only the maintainer can push a `v*` tag. The tag starts
  `.github/workflows/release.yaml`, which publishes nothing until the maintainer approves the
  run in the `release` environment. After the release the maintainer signs the bundle in the
  desktop app (Settings → Plugins → Sign and publish…) and attaches
  `chat.rim.k8s-pods-<version>.rimsig.json` to it by hand.

### Repository settings

The rules above live in the repository's settings on GitHub, which the maintainer keeps:

1. **Default branch** `master`.
2. **Ruleset on `master`.** Require a pull request before merging, with one approval and review
   from Code Owners. Require the status check `Check`. Block force pushes and deletion. Bypass
   list: the maintainer, for pull requests only.
3. **Ruleset on tags `v*`.** Restrict creations, updates and deletions. Bypass list: the
   maintainer only.
4. **Environment `release`.** Required reviewer: the maintainer, with "Prevent self-review"
   off. Deployment branches and tags: the tag pattern `v*` only.
5. **Actions.** Workflow permissions: read repository contents. Actions may not create or
   approve pull requests. Workflows from forks need approval for all external contributors.
   Allowed actions: GitHub's own.
