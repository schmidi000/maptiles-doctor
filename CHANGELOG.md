# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, a breaking change may arrive in a minor release.
Report schema v1 is a consumer contract and is exempt: it will not break within
`schemaVersion: "1.0"`.

## [Unreleased]

### Fixed

- An unknown `--format` exited 2 without printing anything, and only after the
  whole check had run. It is rejected while parsing now, so commander prints the
  reason and lists the valid formats.

## [0.1.1] — 2026-08-02

Fixes a release that could not be used. **Do not install 0.1.0.**

### Fixed

- The installed `maptiles-doctor` binary did nothing: it printed no output and
  exited 0 on every invocation. The entrypoint check compared
  `import.meta.url` against `process.argv[1]`, which never match when npm
  installs a `bin` as a symlink — `node_modules/.bin/maptiles-doctor` pointing
  at `node_modules/maptiles-doctor/dist/index.js`. Resolved paths are compared
  now. Nothing caught it because neither the tests nor a run from a checkout
  goes through a symlink.
- `bin` no longer uses a `./` prefix, which npm rewrote on publish with a
  warning.

### Changed

- The release workflow installs the published packages from the registry in a
  clean directory and asserts that `--version` prints the released version,
  before it tags anything. An exit status alone would have called 0.1.0 a
  successful release.

## [0.1.0] — 2026-08-02

Withdrawn: the CLI binary is inert once installed. Use 0.1.1.

First public release.

### Added

- **Contract engine** (`@maptiles-doctor/core`) checking a MapLibre/Mapbox style
  against the artifacts it ships with:
  - Style syntax, via the MapLibre style specification.
  - Missing source ids, and sources that cannot be read.
  - Missing `source-layer`s, with the nearest declared name suggested.
  - Zoom ranges, judged against the source minzoom only — MapLibre overzooms, so
    a layer drawn above the source maxzoom is never reported.
  - Glyph endpoints, per font stack.
  - Sprite indexes, including the array form that namespaces icons as
    `<sprite-id>:<icon-name>`.
  - Icons, including names a style builds from feature data, completed from
    sampled features and filtered by the layer's own filter.
  - Properties an expression reads that the tiles do not carry.
  - Tile availability.
- **Readers** for PMTiles, MBTiles, TileJSON, and sources that declare their
  tile template inline.
- **Tile sampling**, on by default: real tiles are read at populated anchors and
  the observed layers and properties are ranked as evidence, because declared
  metadata is what drifts. `--sample-at` overrides the anchors.
- **Evidence-ranked severities.** A partial sample can never produce `broken`,
  and a check that could not run is reported as incomplete rather than as a pass.
- **CLI** (`maptiles-doctor`) with `check` and `schema` commands and `pretty`,
  `json`, `sarif`, `github` and `html` output.
- **Report schema v1**, validated on every run and publishable as JSON Schema
  with `maptiles-doctor schema`.
- **GitHub Action** (`packages/action`) running a committed self-contained
  bundle, with workflow annotations and a report output.
- **VS Code extension** (`maptiles-doctor-vscode`) with diagnostics on the
  editor buffer, anchored to the offending style node, plus a report view.
- **Report renderers** (`@maptiles-doctor/report`): standalone HTML, and SARIF
  2.1.0 for code scanning.
- **Visual canaries**, opt-in: render the style with MapLibre GL in headless
  Chromium, report what it drew, and diff against a baseline.
- **Validation harnesses** running the built CLI against production styles from
  four independent providers across three tile schemas, and a seeded-failure
  harness that measures detection against an unmutated baseline.

[Unreleased]: https://github.com/schmidi000/maptiles-doctor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/schmidi000/maptiles-doctor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/schmidi000/maptiles-doctor/releases/tag/v0.1.0
