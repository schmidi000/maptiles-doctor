# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a suspected vulnerability.**

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/schmidi000/maptiles-doctor/security/advisories/new).
If that is not available to you, email **tobias.schmidradler@gmail.com**.

Please include:

- What the issue is and which package and version it affects.
- How to reproduce it, ideally with a minimal style or artifact.
- What an attacker gets out of it.

You will get an acknowledgement within **7 days** and an assessment within
**30 days**. If a fix is warranted, a patched release is published and the
advisory is disclosed alongside it, crediting you unless you prefer otherwise.

## Supported versions

Only the latest published minor version receives security fixes. This project is
pre-1.0; a fix may arrive as a minor rather than a patch release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Threat model

MapTiles Doctor is a developer tool that reads untrusted-ish input: a style file
and the tile, sprite and glyph artifacts it points at, including remote ones. The
things worth reporting are therefore:

- A crafted style, PMTiles/MBTiles archive, sprite index or vector tile that
  causes code execution, a path traversal outside the working directory, or an
  unbounded resource exhaustion in the checker.
- A source location in a style that causes a request to somewhere the operator
  did not intend, or that leaks credentials from the environment.
- A finding message, HTML report or SARIF output that injects markup or workflow
  commands into whatever consumes it.

The following are **not** vulnerabilities in this project:

- The checker fetching a remote artifact the style declares. That is what it is
  for; `--offline` turns it off, and every remote read then reports an
  incomplete check.
- A false positive or a missed contract break. Those are bugs — please open a
  regular issue.
- Vulnerabilities in a dependency that this project does not reach. Report those
  upstream; open an issue here if a version bump is needed.

## Dependency policy

Dependencies are pinned to exact versions and kept at the newest stable patched
release. `npm audit` runs as part of `npm run check` and in CI, and unresolved
high or critical findings block a release. "CVE-free" here means "no known
current audit findings", not a guarantee against undisclosed vulnerabilities.
