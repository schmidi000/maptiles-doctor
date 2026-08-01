# MapTiles Doctor

MapTiles Doctor verifies a MapLibre/Mapbox style against the actual PMTiles,
MBTiles, TileJSON, sprite, glyph, and sampled vector-tile contracts it depends on.

The target failure mode is simple: a style can be valid JSON and still ship a
broken map because `source-layer`, zoom, glyph, sprite, icon, or data-property
assumptions do not match the tileset.

## Status

Deterministic checker, CLI, GitHub Action bundle, VS Code extension with
diagnostics and report view, report renderer, opt-in visual canaries, fixtures,
and tests.

Hosted history, paid team management, and baseline storage are intentionally not
scaffolded yet.

## Install

Use Node `24.18.1` or newer in the Node 24 LTS line and npm `11.11.0` or newer.

```bash
npm install
npm run check
```

## CLI

```bash
npm run build
npx maptiles-doctor check fixtures/broken-style/style.json \
  --source openmaptiles=fixtures/simple-style/tilejson.json \
  --format pretty
```

Useful output formats:

```bash
maptiles-doctor check style.json --source basemap=world.pmtiles --format json
maptiles-doctor check style.json --source basemap=tiles.mbtiles --format sarif
maptiles-doctor check style.json --source basemap=tilejson.json --format github
maptiles-doctor check style.json --source basemap=tilejson.json --format html --output report.html
```

Tile sampling is on by default: the checker reads a few real tiles per source and
uses the layers and feature properties it observes as evidence, because declared
metadata is what drifts. Sampling also resolves icon names a style builds from
feature data, so `["concat", "road_", ["get", "ref_length"]]` is checked against
the shields the tiles really ask for.

Tiles are sampled at well-mapped places rather than at the centre of the source's
bounds, which for a world tileset is open ocean and carries no features. Point it
somewhere else when a source covers ground the built-in anchors miss.

```bash
maptiles-doctor check style.json --source basemap=world.pmtiles --max-sample-tiles 5
maptiles-doctor check style.json --sample-at 13.405,52.52   # sample over Berlin
maptiles-doctor check style.json --sampled-absence risky     # trust the sample more
maptiles-doctor check style.json --no-sample-tiles   # declared metadata only
maptiles-doctor check style.json --offline           # remote reads become incomplete
```

When a source publishes no metadata, a source-layer or property missing from the
sample is reported at `info`, because three tiles will not contain a rare feature
even in a healthy tileset. `--sampled-absence risky` raises it for a tileset
dense enough that absence is worth acting on. It cannot be raised to `broken`: a
sample that did not contain something is not proof that it is missing.

Exit codes:

- `0`: passed
- `1`: findings at or above the fail threshold
- `2`: invalid invocation or runtime error

Every report is validated against report schema v1 before it is returned, and the
schema is published for consumers:

```bash
maptiles-doctor schema --output maptiles-doctor-report.schema.json
```

## GitHub Action

```yaml
- uses: schmidi000/maptiles-doctor/packages/action@main
  with:
    style: style.json
    sources: |
      basemap=world.pmtiles
    fail-threshold: broken
    report: maptiles-doctor-report.json
```

The action runs a committed self-contained bundle (`packages/action/action-dist`),
so a runner needs no install step. Regenerate it with `npm run bundle:action`
after changing action or core sources; `npm run check` fails when the committed
bundle is stale.

MBTiles support depends on the native `better-sqlite3` module, which cannot be
bundled. Inside the action, MBTiles sources report an incomplete check instead of
passing silently; use PMTiles, TileJSON, or a tile directory in CI, or run the
CLI from an installed package.

## VS Code extension

`packages/vscode` runs the same engine against the buffer in the editor, so an
unsaved edit is checked as typed. Style files are checked on open and on save
(`maptilesDoctor.checkOnOpen`, `maptilesDoctor.checkOnSave`), and diagnostics
land on the offending node: the layer's `source-layer`, a zoom bound, an
`icon-image`, or the `sources` entry that could not be read. Two commands are
contributed: `Run MapTiles Doctor` and `Open Report`, which shows the HTML
report beside the editor.

Source overrides, the fail threshold, sampling, and offline mode are settings
under `maptilesDoctor.*`; see `packages/vscode/README.md`.

Build a `.vsix` with:

```bash
npm run package:vsix
```

The bundle in `packages/vscode/extension-dist/` is generated, not committed
(`npm run bundle:vscode`), because only a packaged extension needs it.

## Visual canaries

Deterministic checks read metadata and tiles. A canary renders the style with
MapLibre GL in headless Chromium and reports what the map actually drew:

```bash
maptiles-doctor check style.json \
  --canary 13.405,52.52,14,berlin \
  --screenshot-dir canaries \
  --baseline-dir canaries/baseline
```

`--canary lon,lat,zoom[,id]` is repeatable, and `--canaries <file.json>` takes an
array of definitions with the same fields plus `bearing`, `pitch`, `width`,
`height`, and `expectLayers`. A layer named in `expectLayers` that draws nothing
is reported as `broken`.

A missing baseline is reported as `info` and a render that drifts by more than
`--max-diff-ratio` (0.005 by default) as `risky`, with a diff PNG written next
to the screenshot. Pointing `--screenshot-dir` and `--baseline-dir` at the same
directory compares against the previous run and then updates it.

Canaries are off unless one is configured, and they need two optional peers:

```bash
npm install playwright maplibre-gl
npx playwright install chromium
```

Without them — including inside the GitHub Action bundle, where playwright is
deliberately external — a configured canary is reported as an incomplete check
rather than a pass. MBTiles sources are dropped from a canary for the same
reason and reported as incomplete: a browser cannot read them.

## Packages

- `@maptiles-doctor/core`: style/tile contract engine.
- `maptiles-doctor`: CLI.
- `@maptiles-doctor/action`: GitHub Action wrapper.
- `@maptiles-doctor/report`: static HTML report renderer.
- `maptiles-doctor-vscode`: VS Code extension.

## Dependency policy

Use exact pinned dependencies. Before adding or upgrading libraries, check the
newest stable patched version, run `npm audit`, and do not introduce unresolved
high/critical CVEs without explicit approval.

## Domain

The planned public domain is `maptiles-doctor.com`. Verify and register it
before public launch.
