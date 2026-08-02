# @maptiles-doctor/core

The contract-checking engine behind [MapTiles Doctor](https://github.com/schmidi000/maptiles-doctor).
It reads a MapLibre/Mapbox style and the artifacts it depends on — PMTiles,
MBTiles, TileJSON, sprites, glyphs and the vector tiles themselves — and reports
where they disagree.

Every check lives here. The CLI, the GitHub Action and the VS Code extension are
wrappers around this package.

📖 [Documentation](https://maptiles-doctor.com/)

## Install

```bash
npm install @maptiles-doctor/core
```

Requires Node `24.18.1` or newer.

## Usage

```ts
import { checkStyleContract } from "@maptiles-doctor/core";

const report = await checkStyleContract({
  stylePath: "style.json",
  sources: [{ id: "basemap", location: "world.pmtiles" }],
  failThreshold: "broken"
});

for (const finding of report.findings) {
  console.log(finding.severity, finding.category, finding.message);
}
```

`report` is validated against report schema v1 before it is returned.

## `checkStyleContract(options)`

| Option                   | Default          | What it does                                                                                                             |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stylePath`              | — (required)     | Path or URL of the style. Also the base for resolving relative source, sprite and glyph locations.                       |
| `styleText`              | —                | Style JSON to check instead of the contents of `stylePath`. An editor uses it to check an unsaved buffer.                |
| `sources`                | `[]`             | `{ id, location }` overrides pointing a style source id at a real artifact.                                              |
| `failThreshold`          | `"broken"`       | Lowest severity that makes the report `failed`.                                                                          |
| `allowNetwork`           | `true`           | When false, every remote read becomes an incomplete check instead of a fetch.                                            |
| `sampleTiles`            | `true`           | Read real tiles and treat the observed layers and properties as evidence.                                                |
| `maxSampleTiles`         | `3`              | Tile addresses probed per source.                                                                                        |
| `sampleAt`               | built-in anchors | `[lon, lat]` to sample at, for a source whose data the anchors miss.                                                     |
| `sampledAbsenceSeverity` | `"info"`         | Severity for a finding resting only on absence from a partial sample. `"info" \| "warning" \| "risky"` — never `broken`. |
| `canaries`               | `[]`             | Views to render with MapLibre GL in a headless browser. Off unless at least one is configured.                           |
| `screenshotDir`          | —                | Where canary screenshots and diffs are written.                                                                          |
| `baselineDir`            | —                | Directory of `<canary-id>.png` baselines.                                                                                |
| `maxDiffRatio`           | `0.005`          | Fraction of differing pixels tolerated against a baseline.                                                               |
| `timeoutMs`              | `10000`          | Per-request network timeout.                                                                                             |

Returns a `DoctorReport`:

```ts
interface DoctorReport {
  schemaVersion: "1.0";
  status: "passed" | "failed" | "incomplete";
  generatedAt: string;
  artifactHashes: Record<string, string>;
  checks: Array<{ id: string; status: "passed" | "failed" | "incomplete"; message: string }>;
  findings: Finding[];
  incompleteChecks: IncompleteCheck[];
  summary: { broken: number; risky: number; warning: number; info: number; incomplete: number };
}
```

## Other exports

| Export                                        | What it is                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `checkCategories`                             | Which finding categories each check in the report owns.                    |
| `doctorReportSchema`, `parseDoctorReport`     | Zod schema and parser for a report.                                        |
| `doctorReportJsonSchema()`                    | The equivalent JSON Schema, for consumers outside TypeScript.              |
| `findingCategories`                           | Every finding category the schema publishes.                               |
| `severityRank`                                | `info < warning < risky < broken`, for comparing severities.               |
| `readSourceContract`                          | Read the contract a single PMTiles, MBTiles or TileJSON source declares.   |
| `sampleSourceTiles`, `sampleAddresses`        | Tile sampling on its own.                                                  |
| `collectStyleUsage`                           | What a style asks of its sources: source-layers, properties, icons, fonts. |
| `runVisualCanaries`, `rewriteStyleForBrowser` | Headless rendering, and the style rewrite it needs.                        |

## Severity means evidence strength

`broken` means an artifact was read and proves the mismatch. `risky` means the
evidence points at a mismatch without closing it. `info` is weak evidence.
A check that could not run at all is reported in `incompleteChecks` and never as
a pass — a glyph server that times out does not produce a green report.

A partial sample can never produce `broken`: reading three tiles that do not
contain a rare feature is not proof the feature is missing. And MapLibre
overzooms, so a layer drawn above its source's maxzoom is normal and is never
reported; zoom is judged against the source minzoom only.

## Optional peers

| Package          | Needed for                                    | When missing                                     |
| ---------------- | --------------------------------------------- | ------------------------------------------------ |
| `better-sqlite3` | MBTiles sources (a direct dependency, native) | MBTiles sources report an incomplete check.      |
| `playwright`     | Visual canaries                               | A configured canary reports an incomplete check. |
| `maplibre-gl`    | Visual canaries                               | A configured canary reports an incomplete check. |

Native and browser modules are loaded lazily so a missing binding degrades to an
incomplete check rather than a crash, and so they can stay out of the Action and
VS Code bundles.

## License

Apache-2.0
