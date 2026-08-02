# MapTiles Doctor

[![CI](https://github.com/schmidi000/maptiles-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/schmidi000/maptiles-doctor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/maptiles-doctor.svg)](https://www.npmjs.com/package/maptiles-doctor)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.18.1-brightgreen.svg)](.nvmrc)

**Your style is valid JSON. Your map is still broken.**

MapTiles Doctor checks a MapLibre/Mapbox style against the artifacts it actually
ships with — PMTiles, MBTiles, TileJSON, sprites, glyphs and the vector tiles
themselves — and tells you where they disagree.

📖 **[Documentation](https://maptiles-doctor.com/)** — the full
reference, and the single source of truth for how the checker behaves.

![Two maptiles-doctor runs in a terminal: a failing style with two broken findings and one risky finding, and a style whose icon names are built from feature data, reported as risky and incomplete](https://raw.githubusercontent.com/schmidi000/maptiles-doctor/main/site/media/cli.png)

---

## The problem

Style validators check that a style is well-formed. Tile validators check that a
tileset is well-formed. Neither checks the _join_ between them, which is where
maps actually break:

- A tileset upgrade renames `source-layer: "building"` to `"buildings"`. The
  style still parses. The buildings stop drawing.
- An icon is dropped from the sprite. `icon-image` still resolves at style level.
  The symbols vanish.
- A glyph range stops being served. Labels disappear at one zoom, on one font.
- A property an expression reads is no longer in the tiles. The data-driven
  colour silently falls back to its default.

Nothing in the style is wrong on its own. It just no longer agrees with what is
deployed next to it — and no schema validator can see that, because the evidence
lives in a different artifact.

## Quick start

```bash
npx maptiles-doctor check style.json --source basemap=world.pmtiles
```

```
✖ MapTiles Doctor: failed
Broken 2, risky 1, warnings 0, incomplete 0
broken Layer 3d-buildings references missing source-layer building. Suggestion: buildings.
broken Icon cafe is referenced by the style but missing from the sprite index.
risky Layer cafes references property missing_name, but it is not declared in source-layer poi metadata.
```

Install it if you would rather not use `npx`:

```bash
npm install --save-dev maptiles-doctor
```

Requires Node `24.18.1` or newer.

## What it checks

| Check                 | Catches                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `style-spec`          | Style syntax errors, reported by the MapLibre style specification itself.          |
| `source`              | A layer referencing a source id the style never declares, or one it cannot read.   |
| `source-layer`        | A `source-layer` the tileset does not contain, with the nearest name suggested.    |
| `zoom`                | A layer whose zoom range cannot be served by its source's minzoom.                 |
| `glyph`               | A glyph endpoint that does not serve a font stack the style asks for.              |
| `sprite`              | A sprite index that cannot be read, or a sprite id a reference does not match.     |
| `icon`                | An `icon-image` — including one built from feature data — missing from the sprite. |
| `expression-property` | A property an expression reads that the tiles do not carry.                        |
| `tile-availability`   | A source that returned no tile at any address sampling probed.                     |
| `visual-canary`       | What the map actually drew, rendered headless with MapLibre GL. Opt-in.            |

## Severity means evidence strength

This is the design decision that makes the tool usable on a real style, so it is
worth one paragraph. Every finding is graded by how strong the evidence behind
it is, not by how alarming it sounds:

| Severity   | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `broken`   | An artifact was read and proves the mismatch. Metadata lists the layers and this one is not among them.       |
| `risky`    | Evidence points at a mismatch but does not close it. Metadata omits a property that was never observed.       |
| `warning`  | Worth knowing. Not evidence of a break.                                                                       |
| `info`     | Weak evidence. Something a partial sample did not happen to contain.                                          |
| incomplete | The check could not be completed at all — an unreachable endpoint, a missing native module. **Never a pass.** |

Two rules follow from this and are enforced throughout:

1. **A partial sample can never produce `broken`.** Reading three tiles that do
   not contain a rare feature is not proof the feature is missing. Even
   `--sampled-absence` refuses to accept `broken`.
2. **A failed check is not a passed check.** A glyph server that times out
   produces an incomplete check, never a green run. An incomplete run does not
   exit non-zero on its own; it reports what it could not verify.

MapLibre overzooms, so a layer drawn _above_ its source's maxzoom is normal and
is never reported. Zoom is judged against the source minzoom only.

Full reasoning: [Evidence ranking](https://maptiles-doctor.com/#evidence).

## CLI

```
maptiles-doctor check <style> [options]
maptiles-doctor schema [options]
maptiles-doctor --help
maptiles-doctor --version
```

`<style>` is a path or URL to a style JSON file.

### `check` options

| Option                         | Default          | What it does                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-s, --source <id=path>`       | —                | Point a style source id at the artifact to check it against: a `.pmtiles` or `.mbtiles` file, or a TileJSON file or URL. Repeatable, and overrides what the style declares. Needed whenever the style's own source location is not readable from where you are running — a private endpoint, or a tileset that is not published yet. |
| `-f, --format <format>`        | `pretty`         | `pretty` (human, coloured), `json` (the full report), `sarif` (for GitHub code scanning and other SARIF consumers), `github` (workflow-command annotations), `html` (a standalone report page).                                                                                                                                      |
| `-o, --output <path>`          | stdout           | Write the rendered report to a file instead of stdout.                                                                                                                                                                                                                                                                               |
| `--fail-threshold <severity>`  | `broken`         | Lowest severity that makes the run exit `1`. One of `info`, `warning`, `risky`, `broken`. Set it to `risky` for a stricter gate.                                                                                                                                                                                                     |
| `--timeout-ms <ms>`            | `10000`          | Per-request network timeout. Applies to every remote read: TileJSON, tiles, sprites, glyphs.                                                                                                                                                                                                                                         |
| `--offline`                    | off              | Never touch the network. Every remote read becomes an incomplete check rather than a pass, so an air-gapped run states what it could not see instead of claiming success.                                                                                                                                                            |
| `--no-sample-tiles`            | sampling on      | Check declared metadata only, without reading real tiles. Faster and fully deterministic, but blind to metadata that has drifted from the tiles it describes.                                                                                                                                                                        |
| `--max-sample-tiles <count>`   | `3`              | How many tile addresses to probe per source when sampling. More tiles means stronger evidence and a slower run.                                                                                                                                                                                                                      |
| `--sample-at <lon,lat>`        | built-in anchors | Sample tiles over this location instead of the built-in populated anchors. Use it when a source covers ground the anchors miss — a city-only or region-only tileset.                                                                                                                                                                 |
| `--sampled-absence <severity>` | `info`           | Severity for a finding that rests only on something being absent from a partial sample, where no metadata says either way. `info`, `warning` or `risky`. **`broken` is rejected**: a sample that did not contain something is not proof it is missing.                                                                               |
| `--canary <lon,lat,zoom[,id]>` | —                | Render this view with MapLibre GL in a headless browser and report what it drew. Repeatable. See [Visual canaries](#visual-canaries).                                                                                                                                                                                                |
| `--canaries <path>`            | —                | A JSON file holding an array of canary definitions, for views that need more than `lon,lat,zoom` — `bearing`, `pitch`, `width`, `height`, `expectLayers`.                                                                                                                                                                            |
| `--screenshot-dir <dir>`       | —                | Where canary screenshots and diff images are written.                                                                                                                                                                                                                                                                                |
| `--baseline-dir <dir>`         | —                | Directory of `<canary-id>.png` baselines to compare renders against.                                                                                                                                                                                                                                                                 |
| `--max-diff-ratio <ratio>`     | `0.005`          | Fraction of differing pixels tolerated against a baseline before the drift is reported.                                                                                                                                                                                                                                              |

### `schema` options

| Option                | Default | What it does                                              |
| --------------------- | ------- | --------------------------------------------------------- |
| `-o, --output <path>` | stdout  | Write the report JSON Schema to a file instead of stdout. |

### Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | Passed, or only findings below the threshold. |
| `1`  | Findings at or above the fail threshold.      |
| `2`  | Invalid invocation, or a runtime error.       |

### Examples

```bash
# Check a style against a local PMTiles archive
maptiles-doctor check style.json --source basemap=world.pmtiles

# Upload findings to GitHub code scanning
maptiles-doctor check style.json --format sarif --output results.sarif

# A regional tileset: sample where its data actually is
maptiles-doctor check style.json --sample-at 13.405,52.52

# Deterministic, air-gapped: declared metadata only, no network
maptiles-doctor check style.json --offline --no-sample-tiles

# Fail on risky findings too, and keep an HTML report as a build artifact
maptiles-doctor check style.json --fail-threshold risky \
  --format html --output maptiles-doctor-report.html
```

### The HTML report

`--format html` writes a standalone page — no external assets — suitable for
uploading as a CI artifact. It is the same page the VS Code extension opens
beside the editor.

![The HTML report: status failed, a summary of two broken and one risky finding, and a table of findings with severity, category, message and the path of the artifact each was read from](https://raw.githubusercontent.com/schmidi000/maptiles-doctor/main/site/media/report.png)

## Tile sampling

Sampling is on by default. The checker reads a few real tiles per source and
treats the layers and feature properties it observes as evidence, because
declared metadata is exactly the thing that drifts: a tileset can be rebuilt
without its TileJSON being updated.

Sampling also resolves icon names a style builds from feature data. An
`icon-image` of `["concat", "road_", ["get", "ref_length"]]` is not a name — it
is a recipe. Sampling completes the recipe from real features, evaluates the
layer's filter so names no feature reaching the layer could produce are not
checked, and looks up the shields the tiles genuinely ask for.

Tiles are sampled at well-mapped anchors rather than at the centre of a source's
bounds — the centre of a world tileset is open ocean and carries no features.
`--sample-at` overrides that.

## Report schema

Every report is validated against report schema v1 before it is returned, so a
consumer can rely on its shape. The equivalent JSON Schema is printable:

```bash
maptiles-doctor schema --output maptiles-doctor-report.schema.json
```

```jsonc
{
  "schemaVersion": "1.0",
  "status": "failed", // passed | failed | incomplete
  "generatedAt": "2026-08-02T07:20:35.132Z",
  "artifactHashes": { "…/style.json": "sha256:a29f0dc2…" },
  "checks": [{ "id": "source-layer", "status": "failed", "message": "…" }],
  "findings": [
    {
      "id": "layer.3d-buildings.missing-source-layer",
      "severity": "broken",
      "category": "source-layer",
      "message": "Layer 3d-buildings references missing source-layer building.",
      "layerId": "3d-buildings",
      "sourceId": "openmaptiles",
      "sourceLayer": "building",
      "suggestion": "buildings",
      "evidence": { "availableSourceLayers": ["buildings", "poi"] }
    }
  ],
  "incompleteChecks": [],
  "summary": { "broken": 2, "risky": 1, "warning": 0, "info": 0, "incomplete": 0 }
}
```

A check that never ran produces no entry at all, rather than one that passed.

## GitHub Action

```yaml
- uses: schmidi000/maptiles-doctor/packages/action@v0.1.0
  with:
    style: style.json
    sources: |
      basemap=world.pmtiles
    fail-threshold: broken
    report: maptiles-doctor-report.json
```

| Input                | Default                       | What it does                                                                                                |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `style`              | — (required)                  | Path to the style JSON file.                                                                                |
| `sources`            | —                             | Newline-separated `id=path-or-url` source overrides.                                                        |
| `fail-threshold`     | `broken`                      | Severity at or above which the step fails. An unrecognised value is an error, not a silently disabled gate. |
| `report`             | `maptiles-doctor-report.json` | Where the JSON report is written.                                                                           |
| `offline`            | `false`                       | Report remote artifacts as incomplete instead of fetching them.                                             |
| `skip-tile-sampling` | `false`                       | Check declared metadata only.                                                                               |

| Output   | What it is                    |
| -------- | ----------------------------- |
| `report` | Path to the JSON report file. |

Findings become workflow annotations: `broken` as errors, `risky` and `warning`
as warnings, and `info` plus every incomplete check as notices.

The action runs a committed self-contained bundle
(`packages/action/action-dist`), so a runner needs no install step. **MBTiles
sources report an incomplete check inside the action** — MBTiles needs the
native `better-sqlite3` module, which cannot be bundled. Use PMTiles or TileJSON
in CI, or run the CLI from an installed package.

## VS Code extension

`packages/vscode` runs the same engine against the buffer in the editor, so an
unsaved edit is checked as typed. Style files are checked on open and on save,
and diagnostics land on the offending node: the layer's `source-layer`, a zoom
bound, an `icon-image`, or the `sources` entry that could not be read.

Settings live under `maptilesDoctor.*` and are documented in
[`packages/vscode/README.md`](packages/vscode/README.md).

## Visual canaries

Deterministic checks read metadata and tiles. A canary renders the style with
MapLibre GL in headless Chromium and reports what the map actually drew:

```bash
maptiles-doctor check style.json \
  --canary 13.405,52.52,14,berlin \
  --screenshot-dir canaries \
  --baseline-dir canaries/baseline
```

Rendered evidence is ranked the same way sampled evidence is. An HTTP error
status is `broken`. A request that never completed proves nothing, so it is
incomplete _and_ suppresses every finding that reads what was drawn — a blocked
canary renders an empty map too. A MapLibre error event or an empty render is
`risky`, and a layer named in `expectLayers` that drew nothing is `broken`. A
missing baseline is `info`; drift above `--max-diff-ratio` is `risky` and writes
a diff PNG next to the screenshot.

Canaries are off unless one is configured, and they need two optional peers:

```bash
npm install playwright maplibre-gl
npx playwright install chromium
```

Without them — including inside the GitHub Action bundle, where playwright is
deliberately external — a configured canary reports an incomplete check rather
than a pass.

## Programmatic use

```ts
import { checkStyleContract } from "@maptiles-doctor/core";
import { renderHtmlReport } from "@maptiles-doctor/report";

const report = await checkStyleContract({
  stylePath: "style.json",
  sources: [{ id: "basemap", location: "world.pmtiles" }],
  failThreshold: "broken"
});

if (report.status === "failed") {
  await writeFile("report.html", renderHtmlReport(report));
}
```

`checkStyleContract` also accepts `styleText`, which is what the VS Code
extension uses to check an unsaved buffer while still resolving relative sprite,
glyph and source paths against `stylePath`.

## Packages

| Package                                      | Role                                             |
| -------------------------------------------- | ------------------------------------------------ |
| [`maptiles-doctor`](packages/cli)            | The CLI. Parses flags and calls the engine.      |
| [`@maptiles-doctor/core`](packages/core)     | The contract engine. All check logic lives here. |
| [`@maptiles-doctor/report`](packages/report) | Static HTML and SARIF renderers.                 |
| [`@maptiles-doctor/action`](packages/action) | GitHub Action wrapper.                           |
| [`maptiles-doctor-vscode`](packages/vscode)  | VS Code extension.                               |

The action and the extension are wrappers around the same engine. Native modules
stay out of the bundles and are loaded lazily in core, so a missing binding
degrades to an incomplete check rather than a crash.

## Known limitations

- **MBTiles needs `better-sqlite3`.** Where it is unavailable — the action
  bundle, the VS Code bundle, a browser canary — MBTiles sources report an
  incomplete check.
- **`--source` does not take a `{z}/{x}/{y}` template.** Overrides accept
  `.pmtiles`, `.mbtiles`, or TileJSON. A tile-template directory is only read
  when the style itself declares it in a source's `tiles` array.
- **Sampling is partial by construction.** A property or layer missing from a
  handful of tiles is reported at `info` or `risky`, never `broken`.
- **The false-positive rate is measured, not assumed.** See
  [`validation/FINDINGS.md`](validation/FINDINGS.md) for what running against
  four production styles from independent providers actually found.

## Development

```bash
npm install
npm run check     # audit, typecheck, lint, test, build, package + bundle checks
```

| Command                  | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `npm test`               | Run the test suite.                                                  |
| `npm run coverage`       | Test suite with coverage.                                            |
| `npm run build`          | Compile every package.                                               |
| `npm run fixtures:build` | Generate the binary tile fixtures (also run automatically by tests). |
| `npm run bundle:action`  | Rebuild the committed GitHub Action bundle.                          |
| `npm run package:vsix`   | Build the VS Code `.vsix`.                                           |
| `npm run validate:real`  | Run the CLI against production styles from real providers.           |
| `npm run validate:seed`  | Seed known contract breaks into a real style and count detections.   |

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the details, including why fixtures are
generated rather than committed and what a new check needs.

## Security

Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md). Please do
not open a public issue for a suspected vulnerability.

## License

[Apache-2.0](LICENSE).
