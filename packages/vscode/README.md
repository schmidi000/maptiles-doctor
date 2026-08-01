# MapTiles Doctor for VS Code

Checks a MapLibre/Mapbox style against the tile, glyph, sprite, and sampled
vector-tile artifacts it depends on, and reports the mismatches as diagnostics
on the style file you are editing.

A style can be valid JSON and still ship a broken map because `source-layer`,
zoom, glyph, sprite, icon, or data-property assumptions no longer match the
tileset. This extension runs the same engine as the `maptiles-doctor` CLI and
GitHub Action, against the buffer in the editor rather than the file on disk.

## Features

- Diagnostics on open and on save for any JSON file that looks like a style
  (a `version` and a `layers` array).
- Squiggles land on the offending node: the layer's `source-layer`, `minzoom`,
  `icon-image`, or the `sources` entry that could not be read.
- Broken contracts are errors, risky ones warnings, and checks that could not
  complete — an unreachable glyph endpoint, an unreadable sprite index —
  appear as information rather than silently passing.
- `MapTiles Doctor: Run MapTiles Doctor` checks the active style on demand.
- `MapTiles Doctor: Open Report` opens the full HTML report beside the editor.

## Settings

| Setting                         | Default  | Purpose                                                                                         |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `maptilesDoctor.sources`        | `{}`     | Source overrides keyed by style source id. Relative paths resolve against the workspace folder. |
| `maptilesDoctor.failThreshold`  | `broken` | Lowest severity that marks the report failed.                                                   |
| `maptilesDoctor.offline`        | `false`  | Report remote artifacts as incomplete instead of fetching them.                                 |
| `maptilesDoctor.sampleTiles`    | `true`   | Read real tiles and use observed layers and properties as evidence.                             |
| `maptilesDoctor.maxSampleTiles` | `3`      | Tile addresses probed per source.                                                               |
| `maptilesDoctor.timeoutMs`      | `10000`  | Network timeout in milliseconds.                                                                |
| `maptilesDoctor.checkOnOpen`    | `true`   | Check a style file when it is opened.                                                           |
| `maptilesDoctor.checkOnSave`    | `true`   | Check a style file when it is saved.                                                            |

A style whose sources have no inspectable location — a `tiles` array pointing at
a private endpoint, for example — needs a `maptilesDoctor.sources` override to
be checked:

```json
{
  "maptilesDoctor.sources": {
    "openmaptiles": "tiles/world.pmtiles"
  }
}
```

## Limitations

- MBTiles sources need the native `better-sqlite3` module. When it is missing,
  those sources report an incomplete check instead of passing.
- Sampling reads a few tiles per source, so a property missing from the sample
  is reported as risky or informational, never as a broken contract.
