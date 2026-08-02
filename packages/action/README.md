# MapTiles Doctor GitHub Action

Check a MapLibre/Mapbox style against its PMTiles, MBTiles, TileJSON, sprite and
glyph artifacts on every push and pull request, and fail the job when they no
longer agree.

📖 [Documentation](https://maptiles-doctor.com/) ·
[Repository](https://github.com/schmidi000/maptiles-doctor)

## Usage

```yaml
name: Map contract

on: [push, pull_request]

jobs:
  maptiles-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: schmidi000/maptiles-doctor/packages/action@v0.1.0
        with:
          style: style.json
          sources: |
            basemap=world.pmtiles
          fail-threshold: broken
          report: maptiles-doctor-report.json
```

No install step is needed: the action runs a committed self-contained bundle.
`@v0` tracks the latest `0.x` release; pin the exact `vX.Y.Z` tag if you would
rather not pick up a pre-1.0 breaking change.

## Inputs

| Input                | Default                       | What it does                                                                                                                                      |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `style`              | — (required)                  | Path to the style JSON file.                                                                                                                      |
| `sources`            | —                             | Newline-separated `id=path-or-url` overrides pointing style source ids at real artifacts.                                                         |
| `fail-threshold`     | `broken`                      | Severity at or above which the step fails: `info`, `warning`, `risky`, `broken`. An unrecognised value is an error, not a silently disabled gate. |
| `report`             | `maptiles-doctor-report.json` | Where the JSON report is written.                                                                                                                 |
| `offline`            | `false`                       | Report remote artifacts as incomplete instead of fetching them.                                                                                   |
| `skip-tile-sampling` | `false`                       | Check declared metadata only, without reading real tiles.                                                                                         |

## Outputs

| Output   | What it is                    |
| -------- | ----------------------------- |
| `report` | Path to the JSON report file. |

## Annotations

Findings appear on the workflow run: `broken` as errors, `risky` and `warning`
as warnings, and `info` plus every incomplete check as notices. `info` is
deliberately a notice — it is weak evidence, and annotating it as a warning
floods the run and overstates the report.

## Uploading to code scanning

The CLI emits SARIF if you would rather see findings on the diff:

```yaml
- run: npx maptiles-doctor check style.json --format sarif --output results.sarif
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: results.sarif
```

## Limitations

**MBTiles sources report an incomplete check inside the action.** MBTiles needs
the native `better-sqlite3` module, which cannot be bundled into a
self-contained action. Use PMTiles or TileJSON in CI, or run the CLI from an
installed package. An unreadable source is reported as incomplete rather than
passing silently.

**Visual canaries do not run inside the action.** Playwright is deliberately
external to the bundle, so a configured canary reports an incomplete check.

## Development

The bundle in `action-dist/` is committed so a runner needs no install step.
Regenerate it after changing action or core sources:

```bash
npm run bundle:action
```

`npm run check` fails when the committed bundle is stale.

## License

Apache-2.0
