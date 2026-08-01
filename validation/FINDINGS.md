# First real-world validation run

Date: 2026-07-31. Four production styles, three tile schemas, four independent
providers. Checker built from `65fa3ed`.

| Target                | Status     | Findings | Incomplete |
| --------------------- | ---------- | -------- | ---------- |
| openfreemap-liberty   | failed     | 110      | 1          |
| maplibre-demotiles    | incomplete | 6        | 1          |
| versatiles-colorful   | failed     | 110      | 1          |
| stadia-alidade-smooth | failed     | 43       | 52         |

269 findings. **264 are false positives (98%).** Three of the four styles would
fail CI today, and all four render correctly in production.

| Category                   | Count | Verdict                       | Status      |
| -------------------------- | ----- | ----------------------------- | ----------- |
| `zoom/risky`               | 140   | False positive — bug 1        | Fixed       |
| `icon/broken`              | 114   | False positive — bugs 2 and 3 | Bug 2 fixed |
| `zoom/broken`              | 10    | False positive — bug 1        | Fixed       |
| `expression-property/info` | 5     | Correct                       | —           |

## Progress

| Target                | Original | After bug 1 | After bug 2 | After bug 3 | After sampling | After filters |
| --------------------- | -------- | ----------- | ----------- | ----------- | -------------- | ------------- |
| openfreemap-liberty   | 110      | 7           | 7           | 5           | 63             | 22            |
| maplibre-demotiles    | 6        | 0           | 0           | 0           | 0              | 0             |
| versatiles-colorful   | 110      | 110         | 1           | 0           | 0              | 15            |
| stadia-alidade-smooth | 43       | 2           | 2           | 0           | 0              | 0             |
| **Total**             | **269**  | **119**     | **10**      | **5**       | **63**         | **37**        |

Of Liberty's 22, 21 are real defects that the checker could not see until it
sampled somewhere with features in it, and 1 is a correct
`expression-property/info`. Versatiles' 15 are `info`, reclassified from `risky`
when sampled absence was ranked as weak evidence; the column counts findings at
every severity.

The "After sampling" column claimed no false positives remained. Forty-one of
Liberty's 63 were false positives: layer filters were never evaluated, so names
no feature reaching the layer could produce were checked against the sprite
anyway. See "The other 41 were false positives" below.

Every style ends `incomplete` rather than `passed`, which is the honest answer:
stadia has 55 incomplete checks and the others 1 each, recording a 404 raster
source, a key-gated provider, and an inline GeoJSON source.

## Bug 1 — Overzoom is treated as a defect (150 findings) — FIXED

Fixed by judging zoom against the source minzoom only. `zoom-mismatch` was
rebuilt around a source with `minzoom: 8` because the old fixture asserted the
false positive as correct behaviour, and `zoom-overzoom` was added to hold the
rule down. The `broken-style` fixture also had an overzoom layer whose finding
the suite expected; that expectation is gone.

The original rule treated the source zoom range as a hard window in both
directions:

```
Layer park zoom range 0-24 extends outside source openmaptiles range 0-14.   [risky]
Layer road_one_way_arrow zoom range 16-24 does not overlap source openmaptiles range 0-14.   [broken]
```

Both are wrong, and wrong in the same way. MapLibre **overzooms**: a vector
source with `maxzoom: 14` keeps rendering above z14 by scaling its z14 tiles.
This is not a degraded fallback, it is how every vector basemap works — it is
how you get building outlines at z18 out of a tileset that stops at z14.
`road_one_way_arrow` drawing only at z16+ against a maxzoom-14 source is not a
broken contract; it is the normal way to show one-way arrows only when zoomed in.

The rule is only sound on the minzoom side, because MapLibre does **not**
underzoom — below a source's minzoom there is genuinely no data:

| Condition              | Current  | Correct            |
| ---------------------- | -------- | ------------------ |
| `layerMax > sourceMax` | `risky`  | not a finding      |
| `layerMin > sourceMax` | `broken` | not a finding      |
| `layerMin < sourceMin` | `risky`  | `risky` — correct  |
| `layerMax < sourceMin` | `broken` | `broken` — correct |

Half the rule has to go. This is the single largest false-positive source and it
fires on every style tested, including MapLibre's own demo style.

## Bug 2 — Multi-sprite namespaces are not resolved (112 findings) — FIXED

Every icon in versatiles-colorful was reported missing:

```
Icon basics:icon-art_gallery is referenced by the style but missing from the sprite index.   [broken]
```

The style uses the array form of `sprite`:

```json
"sprite": [{ "id": "basics", "url": "https://tiles.versatiles.org/assets/sprites/basics/sprites" }]
```

With multiple sprites, the spec namespaces icon references as
`<sprite-id>:<icon-name>`. Verified against the live index: it contains
`icon-art_gallery`, not `basics:icon-art_gallery`. The checker looks up the
namespaced string verbatim, so every lookup misses.

Two defects, not one. `spriteBaseUrl` collapsed the array to the **first**
sprite's URL, so every other declared sprite was never read at all; and the
namespaced reference was looked up verbatim.

Fixed by reading every declared sprite, resolving the `<id>:` prefix against the
sprite of that id, and reporting an unknown prefix as its own finding rather
than as a missing icon. A sprite whose index cannot be read leaves its icons
unreported, because "could not verify" must not become "broken". Suggestions are
re-namespaced, so a fix can be pasted back into the style. Fixture:
`multi-sprite`.

## Bug 3 — Data-driven icon references are harvested as literals (5 findings) — FIXED

All five findings that survive bugs 1 and 2 are this one:

```
Icon to-string is referenced by the style but missing from the sprite index.       liberty
Icon  is referenced by the style but missing from the sprite index.                liberty
Icon  names sprite <unprefixed>, which the style does not declare.                 versatiles
Icon road_{ref_length} is referenced by the style but missing from the sprite index.      stadia
Icon {network}_{ref_length} is referenced by the style but missing from the sprite index. stadia
```

Three distinct forms, all runtime-resolved. From these real `icon-image` values
in liberty and stadia:

```json
["to-string", ["get", "class"]]
["step", ["zoom"], "circle_11_black", 10, ""]
"road_{ref_length}"
```

1. **Operator names read as icon literals.** `to-string` is the expression's
   operator, not an icon.
2. **The empty string treated as an icon name.** `""` is the standard idiom for
   "draw no icon here".
3. **Legacy token syntax taken literally.** `road_{ref_length}` is the pre-
   expression `{field}` interpolation, substituted from feature data at render
   time. Stadia still uses it; both of its remaining findings are this.

The common cause: all three are **data-driven** references. `["get","class"]`
and `{ref_length}` both mean the icon name is decided by feature data at render
time, so no static walk can enumerate it. Scraping visible string literals
produces false positives like these five _and_ false negatives, because the
values that actually matter live in the tiles.

Fixed by enumerating the names from sampled tiles rather than skipping the
check. An `icon-image` is reduced to a sequence of literals and property
lookups, so `"road_{ref_length}"` and `["concat", "road_", ["get","ref_length"]]`
produce the same shape, and each sampled feature completes it into a name the
sprite index can answer for.

Three decisions worth keeping:

- **Combinations are recorded per feature, not per property.** Taking the
  distinct values of `network` and `ref_length` separately and crossing them
  would invent pairs that never occur together, which is a false positive
  generator. The sampler records the properties a template reads as tuples, so
  only real combinations are checked. `collectStyleUsage` therefore runs before
  sampling, to tell the sampler which properties matter; nothing is recorded
  when a style has no data-driven icon.
- **A sampled name missing from the sprite is `risky`, not `broken`.** The
  sprite index is authoritative that the icon is absent, but only a partial
  sample says the value occurs at all, and a partial sample must never fail a
  build on its own.
- **A template no sampled feature can complete is an incomplete check.** It is
  also enough to keep the `assets` check off `passed`, which previously only
  looked at the `glyph` and `sprite` categories.

Fixture: `data-driven-icon`.

## What worked

Worth recording, because these are the design decisions holding up under real
data:

- **Stadia's 401s became 52 incomplete checks, not passes.** A key-gated provider
  is exactly the case where a lazy checker reports a clean bill of health. It
  didn't.
- **`crimea`, an inline GeoJSON source, produced an actionable incomplete check**
  rather than a crash or a bogus finding.
- **`expression-property` findings came out as `info`** and did not fail the
  build — the partial-sample rule behaving as designed.
- **Speed is fine**: 2–3 s per style, including network, for styles up to 324
  layers.

## Bug 4 — An inline `tiles[]` source is fetched as if it were TileJSON — FIXED

This was the open question about liberty's 404 and versatiles' 500. Both are
ours, and the seeded-failure harness is what forced the verdict: versatiles
scores 5 of 7 because two seeded breaks cannot be detected at all while its
source is unreadable.

`sourceLocationFromStyleSource` in `packages/core/src/checker.ts` falls back to
`record.tiles[0]` when a source has no `url`, and that string is a tile
_template_. It is then handed to `readSourceContract`, which fetches it
verbatim:

```
GET https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}   -> 500
GET https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png -> 404
```

The tiles themselves are fine — `…/tiles/osm/0/0/0` and `…/14/14549/6451` both
return 200. The request is malformed, not the provider.

A source declared inline this way already carries its own contract: `tiles`,
`bounds`, `minzoom`, `maxzoom`, and sometimes `vector_layers`. It should be read
from the style object rather than fetched. Nothing about it needs the network
to build a contract.

The cost is not one incomplete check. An unreadable source disables every
downstream check for it — source-layer, zoom, expression-property, and tile
availability all go quiet, and the seeded harness measured that directly: 2 of
the 7 applicable seeds were undetectable on versatiles purely because of this.
Inline `tiles[]` sources are common, so this was a large blind spot.

Fixed by building the contract from the style object. A raster source is marked
as such and skipped by the sampler rather than parsed as MVT, since a PNG has no
vector layers; its zoom range still checks. An explicit `--source` override
still wins, because it points at a real archive that carries more than the style
declares. Fixture: `inline-tiles-style`.

Effect on the corpus:

| Target              | Before          | After                                  |
| ------------------- | --------------- | -------------------------------------- |
| versatiles-colorful | incomplete, 0/1 | **passed**, 15 findings / 0 incomplete |
| seeded detection    | 5 of 7          | **7 of 7**                             |

VersaTiles is the first corpus style to reach `passed`. Its 15 findings are all
sampling-absence `risky` entries, which is the documented behaviour for a source
that declares no `vector_layers`: sampled tiles are the only evidence, so an
absent source-layer or property is suspicious rather than proven.

### Sampled absence now defaults to `info` — FIXED

`dam_polygons`, `pier_lines`, `ferries`, and a `coastline` property are genuinely
rare. Three tiles over London, New York and Tokyo will never contain them, so
"no sampled tile contains it" was true but weak — 15 `risky` findings against a
style that is fine.

Two rules rested on this, not one: a source-layer absent from every sampled tile
of a source with no metadata, and a property that neither metadata declares nor
any sampled feature carries. Both now take `sampledAbsenceSeverity`, defaulting
to `info`. `--sampled-absence risky` raises them for a tileset dense enough that
absence means something, and `broken` is rejected outright, because a sample
that did not contain something is not proof that it is missing.

What did **not** change:

- Liberty's icon findings stay `risky`. They rest on a sampled feature
  _producing_ a name the sprite lacks, which is positive evidence, not absence.
  (62 at the time; 21 after layer filters were evaluated — see below.)
- A property that metadata lists fields for and omits stays `risky`. Metadata
  saying "these are the fields" is evidence; an empty sample is not.

| Target              | Before           | After     |
| ------------------- | ---------------- | --------- |
| versatiles-colorful | 15 risky         | 15 info   |
| openfreemap-liberty | 62 risky, 1 info | unchanged |

<!-- Liberty's row is what this change did at the time; layer-filter evaluation
     later took the 62 to 21. -->


Seeded detection is unchanged at 9/9 and 7/7: severity does not affect whether a
break is noticed, only how loudly it is reported.

## Where the sample lands — FIXED

Fixing bug 3 exposed the limit above it. `sampleAddresses` probed the centre of
the source bounds, and the centre of a world tileset is open ocean, so POI and
road-shield layers had nothing to sample. Liberty ended with 10 incomplete icon
checks: the check was correct and simply had no data to work from.

Fixed by sampling one populated anchor per zoom — London, New York, Tokyo, and
onwards — so a three-tile run looks at three places rather than three scales of
one. A source whose bounds contain no anchor falls back to its own centre, which
keeps regional extracts working, and `--sample-at lon,lat` overrides the choice.
`scripts/build-fixtures.mjs` writes its tiles at these addresses, and a test
imports the generator to assert the two agree, because anchors that drift out of
sync would silently empty every fixture sample.

### It immediately found a bug in the bug 3 fix

With real POI data to read, liberty jumped to 425 findings. Liberty's POI layers
are written:

```json
["match", ["get", "subclass"], ["florist", "furniture"], ["get", "subclass"], ["get", "class"]]
```

That `subclass` branch is only reachable when subclass is `florist` or
`furniture`, but the extractor treated it as unconstrained and asked the sprite
for every POI subclass in the tileset — 135 phantom names per layer. A `match`
branch that re-reads the property the match tested can only produce that
branch's labels. Constraining it took 425 back to 62.

## The first real findings

Twenty-one of the 62 are real. Verified against the live OpenFreeMap sprite
index, which holds 264 entries: POI classes reaching the `["get", "class"]`
default branch that the sprite has no icon for — `office`, `atm`, `gate`,
`bollard`, `recycling`, `toll_booth`, `bicycle_parking`, `sports_centre`,
`swimming_pool`, and others. Those POIs render with no icon at all.

This is the failure this product exists to catch, found in a style shipping in
production, by a check that could not have found anything a day ago. It is also
why the severity is `risky` rather than `broken`: a three-tile sample proves
those values occur somewhere, not how much of the map they affect.

### The other 41 were false positives — FIXED

This section previously claimed all 62 were real. Forty-one were not, and the
claim was wrong for one reason: candidate names were built from every feature in
the source-layer, and a layer's `filter` was never consulted. See
`docs/bug_analysis.md`.

- **Six road-shield findings, none reachable.** All three shield layers filter
  `["<=", ["get", "ref_length"], 6]`, so the sampled `ref_length` values of 7 and
  11 are exactly the ones the style refuses to draw — `road_7` and `road_11` are
  never requested. Two of those layers additionally filter `network` to
  `us-interstate`/`us-highway`/`us-state`, while the reported names come from
  features whose `network` is `road`, so they were excluded twice over. The
  earlier reading of this — "the sprite ships `road_1` through `road_6`, so 7 and
  11 render blank" — mistook the style's own guard for the bug.
- **Fourteen `poi_transit` findings, none reachable.** That layer filters `class`
  to `airport`, `bus`, and `rail`; every name reported against it was one of the
  other classes in the source-layer.
- **Twenty-one duplicates across the rank tiers.** `poi_r1`, `poi_r7`, and
  `poi_r20` partition on `rank`, which sampling did not retain, so the same 14
  names were reported against all three. With `rank` retained and the filters
  evaluated they come out 14 / 6 / 1, because a class only appears in the tiers
  its features' ranks fall into.

The checker now evaluates each layer's filter against the sampled feature that
produced a name, and refuses to guess: a filter needing real geometry or feature
state makes the check incomplete rather than reported either way.

| Layer set             | Before | After |
| --------------------- | ------ | ----- |
| poi_r20 / poi_r7 / poi_r1 | 14 / 14 / 14 | 14 / 6 / 1 |
| poi_transit           | 14     | 0     |
| three shield layers   | 2 each | 0     |

Retention is now budgeted per candidate name rather than across all combinations.
A flat cap of 200 was fine until filter inputs joined the sample: crossing `class`
and `subclass` with `rank` overran it and dropped whole class values, which reads
as "every icon resolves". A source-layer that still exceeds the budget reports an
incomplete check, because a bound that is not reported is indistinguishable from
a clean result.

## Recommended order

1. ~~Bug 1 (150 findings, trivial fix, fires on every style).~~ Done.
2. ~~Bug 2 (112 findings, contained to sprite resolution).~~ Done.
3. ~~Bug 3 (5 findings, but the design question behind it is the real work).~~ Done.
4. ~~Re-run, then triage what survives.~~ Done, then redone: the triage missed
   that layer filters were never evaluated. 41 of the 62 were false positives.
5. ~~Improve where tiles are sampled, so data-driven checks have features to read.~~ Done.
6. ~~The seeded-failure harness for the 8-of-10 release gate.~~ Done: 9 of 9 on
   liberty, 5 of 7 on versatiles.
7. ~~Bug 4, the largest remaining blind spot.~~ Done: versatiles now passes and
   detects 7 of 7.
8. ~~Decide what absence from a three-tile sample is worth.~~ Done: `info` by
   default, raisable with `--sampled-absence`, never `broken`.
9. Next: publish `@maptiles-doctor/core` and the CLI, so `npx maptiles-doctor`
   works at all. It is acceptance criterion one and stage 8a's prerequisite.

## Seeded-failure results

`npm run validate:seed` seeds ten known contract breaks into a real style and
counts what the checker notices, measured as a diff against the unmutated
baseline so a style that already has findings cannot score off noticing nothing.

| Target              | Detected | As findings | As incomplete | Not expressible |
| ------------------- | -------- | ----------- | ------------- | --------------- |
| openfreemap-liberty | 9 / 9    | 6           | 3             | 1               |
| versatiles-colorful | 7 / 7    | 5           | 2             | 3               |

The release gate is met on liberty. Versatiles detects everything that can be
expressed against it, but only 7 of the 10 mutations are, so the gate cannot be
evaluated there — the harness says exactly that rather than reporting a failure,
which would read as a detection problem when it is a coverage one.

An incomplete check counts as caught, because an unreachable artifact is meant to
report incomplete rather than pass; the split is reported rather than hidden.

Two things the harness surfaced about the checker itself:

- **`zoom-below-source` is not expressible against any corpus style.** After the
  bug 1 fix the zoom check only fires when a source's minzoom is above 0, and no
  production basemap here starts above 0. The fix was right — the old rule was
  150 false positives — but the honest reading is that zoom checking now has
  almost no reach on typical tilesets.
- **Versatiles' two misses were bug 4**, not detection weakness. With its source
  unreadable, a renamed source-layer and a missing property produced nothing new,
  because the checks that would catch them never ran. Fixing bug 4 took it to
  7 of 7.

The harness also caught a flaw in itself: the data-driven icon mutation
originally scored a pass off the _static_ icon check, because wrapping a `match`
in `concat` produces static names from its constrained branches. Mutations that
target a specific check now assert which check caught them.
