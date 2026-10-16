# Security policy

## Supported versions

Only the latest release and the `master` branch are supported; fixes land on `master` and go
out in a new release.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting on this repository: open
the **Security** tab and choose **Report a vulnerability**. Never open a public issue, pull
request or discussion for a vulnerability.

Include what you can of:

- what the vulnerability is and what an attacker gains from it;
- the plugin version or commit you tested, and the RIM app version (Settings > About);
- the platform: Linux, macOS, Windows or a browser, with versions;
- steps or a proof of concept that reproduce it;
- any logs, with tokens, keys, passwords and personal data removed.

## What happens next

- We acknowledge the report within seven days.
- We send a fix, or a decision with the reasons for it, within ninety days.
- We agree with you when the issue is disclosed, normally once a fixed release is out.
- We credit you in the advisory if you want, under the name you choose.

## Scope

This policy covers this repository: the Kubernetes Pods plugin, its panel and its release bundles.
The RIM app, its plugin host, the web plugin sandbox and the plugin SDK are covered by the
`SECURITY.md` in the [`rim-ui`](https://github.com/rim-platform/rim-ui/blob/master/SECURITY.md)
repository, and the server by the one in `rim-server`; report those there.

Out of scope: findings that need an already compromised device or operating system account,
and reports produced by an automated scanner without a demonstrated impact.
