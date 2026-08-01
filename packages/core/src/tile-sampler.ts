import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { isHttpUrl, locationDir, readRemoteBytes, resolveLocation } from "./io.js";
import { openMbtiles, openPmtiles } from "./source-reader.js";
import type { SampledFeature, SourceContract, TileAddress, TileSample } from "./types.js";

export interface SampleOptions {
  timeoutMs: number;
  allowNetwork: boolean;
  maxTiles?: number;
  /**
   * Properties an `icon-image` builds a name from, together with the ones its
   * layer filters on. Their values are recorded per feature so the names a style
   * really produces can be enumerated and checked against the filter that
   * decides which features reach the layer. Nothing is recorded when this is
   * empty, which is the common case.
   */
  valueProperties?: Set<string> | undefined;
  /**
   * The subset of `valueProperties` a name is actually built from. Retention is
   * budgeted per distinct combination of these rather than across all of them,
   * so a property with wide variety that only appears in a filter — `rank`, on a
   * POI layer — cannot crowd out the class values whose icons are the point.
   */
  keyProperties?: Set<string> | undefined;
  /** Longitude and latitude to sample at, overriding the built-in anchors. */
  sampleAt?: [number, number] | undefined;
}

/**
 * Enough distinct candidate names to find a missing icon without holding a
 * tile's worth of strings, and enough variants of each to give a layer filter a
 * fair chance of admitting one. A source-layer with more variety than this is
 * sampled, not enumerated, and says so through `truncatedCombinations`.
 */
const maxValueKeys = 500;
const maxVariantsPerKey = 20;

/**
 * Reads a handful of real tiles from a source and reports the layers and
 * feature properties they actually contain. Declared metadata is what drifts,
 * so sampled observations are the only evidence that a source-layer or property
 * is really being shipped.
 */
export async function sampleSourceTiles(
  contract: SourceContract,
  options: SampleOptions
): Promise<TileSample> {
  const sample: TileSample = {
    attempted: [],
    retrieved: [],
    layers: new Map(),
    failures: []
  };

  const remote = isRemoteSource(contract);
  if (remote && !options.allowNetwork) {
    sample.skipped = "Network access is disabled.";
    return sample;
  }
  if (contract.kind === "tilejson" && !contract.tileUrls?.length) {
    sample.skipped = "TileJSON declares no tile URL template.";
    return sample;
  }
  if (contract.kind === "raster") {
    sample.skipped = "Raster tiles carry no vector layers to sample.";
    return sample;
  }
  if (contract.kind === "unknown" || contract.kind === "style") {
    sample.skipped = `Sampling is not supported for ${contract.kind} sources.`;
    return sample;
  }

  for (const address of sampleAddresses(contract, options.maxTiles ?? 3, options.sampleAt)) {
    sample.attempted.push(address);
    try {
      const bytes = await readTile(contract, address, options.timeoutMs);
      if (!bytes) {
        continue;
      }
      sample.retrieved.push(address);
      mergeTile(sample, bytes, address.z, options.valueProperties, options.keyProperties);
    } catch (error) {
      sample.failures.push(
        `${address.z}/${address.x}/${address.y}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return sample;
}

/**
 * Dense, well-mapped places on five continents. The centre of a world tileset's
 * bounds is open ocean, so sampling there reads a tile with no roads, no POIs,
 * and no labels, and every check that needs a feature comes back unverifiable.
 * Ordered, so a run stays deterministic.
 */
const populatedAnchors: [number, number][] = [
  [-0.1276, 51.5072], // London
  [-74.006, 40.7128], // New York
  [139.6917, 35.6895], // Tokyo
  [-46.6333, -23.5505], // São Paulo
  [3.3792, 6.5244], // Lagos
  [77.209, 28.6139], // Delhi
  [151.2093, -33.8688] // Sydney
];

/**
 * Zoom levels spread across the source range, each at a place likely to carry
 * features. `sampleAt` overrides the choice for a source whose data sits
 * somewhere this cannot guess.
 */
export function sampleAddresses(
  contract: SourceContract,
  maxTiles: number,
  sampleAt?: [number, number] | undefined
): TileAddress[] {
  const minzoom = clampZoom(contract.minzoom ?? 0);
  const maxzoom = clampZoom(contract.maxzoom ?? minzoom);
  const bounds = contract.bounds ?? [-180, -85.051129, 180, 85.051129];
  const [west, south, east, north] = bounds;

  const anchors = sampleAt
    ? [sampleAt]
    : withinBounds(bounds).length > 0
      ? withinBounds(bounds)
      : // A regional extract this knows no city inside falls back to its own
        // centre, which for a small bounding box is as good a guess as exists.
        [[(west + east) / 2, (south + north) / 2] as [number, number]];

  // `maxTiles` is the number of addresses to probe, so the zooms are spread
  // across the source range to fill it. Adding only a midpoint capped every run
  // at three addresses however large the option was set, which made asking for
  // more confidence in a sampled finding do nothing at all.
  const requested = Math.max(1, maxTiles);
  const zooms = new Set<number>([minzoom]);
  if (requested > 1) {
    zooms.add(maxzoom);
  }
  for (let step = 1; step < requested - 1 && zooms.size < requested; step += 1) {
    zooms.add(clampZoom(minzoom + ((maxzoom - minzoom) * step) / (requested - 1)));
  }

  // Each zoom takes a different anchor, so a run that probes three tiles looks
  // at three places rather than three scales of one.
  return [...zooms]
    .sort((a, b) => a - b)
    .slice(0, requested)
    .map((z, index) => {
      const [lon, lat] = anchors[index % anchors.length]!;
      return { z, ...lonLatToTile(lon, lat, z) };
    });
}

function withinBounds(bounds: [number, number, number, number]): [number, number][] {
  const [west, south, east, north] = bounds;
  return populatedAnchors.filter(
    ([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north
  );
}

function isRemoteSource(contract: SourceContract): boolean {
  if (contract.kind === "tilejson") {
    const template = contract.tileUrls?.[0];
    return template ? isHttpUrl(template) : isHttpUrl(contract.location);
  }
  return isHttpUrl(contract.location.replace(/^pmtiles:\/\//, ""));
}

async function readTile(
  contract: SourceContract,
  address: TileAddress,
  timeoutMs: number
): Promise<Uint8Array | undefined> {
  if (contract.kind === "pmtiles") {
    const tile = await openPmtiles(contract.location).getZxy(address.z, address.x, address.y);
    return tile ? new Uint8Array(tile.data) : undefined;
  }

  if (contract.kind === "mbtiles") {
    return readMbtilesTile(contract.location, address);
  }

  const template = contract.tileUrls?.[0];
  if (!template) {
    return undefined;
  }
  const target = template
    .replace("{z}", String(address.z))
    .replace("{x}", String(address.x))
    .replace("{y}", String(address.y));

  // Resolved against the TileJSON that declared it before it is classified: a
  // relative template under a remote TileJSON is a URL, and testing the raw
  // template for `http` sent it to the filesystem reader instead.
  const resolved = resolveLocation(target, locationDir(contract.location));
  if (isHttpUrl(resolved)) {
    const bytes = await readRemoteBytes(resolved, timeoutMs);
    return bytes ? decompress(bytes) : undefined;
  }

  // A tile template can also point at a directory of tiles on disk.
  return readLocalTile(resolved);
}

async function readLocalTile(path: string): Promise<Uint8Array | undefined> {
  try {
    return decompress(new Uint8Array(await readFile(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readMbtilesTile(
  location: string,
  address: TileAddress
): Promise<Uint8Array | undefined> {
  const database = await openMbtiles(location);
  try {
    // MBTiles rows are TMS, so the y axis is flipped relative to XYZ.
    const tmsRow = 2 ** address.z - 1 - address.y;
    const row = database
      .prepare(
        "select tile_data from tiles where zoom_level = ? and tile_column = ? and tile_row = ?"
      )
      .get(address.z, address.x, tmsRow) as { tile_data: Buffer } | undefined;
    return row ? decompress(new Uint8Array(row.tile_data)) : undefined;
  } finally {
    database.close();
  }
}

function mergeTile(
  sample: TileSample,
  bytes: Uint8Array,
  zoom: number,
  valueProperties: Set<string> | undefined,
  keyProperties: Set<string> | undefined
): void {
  const tile = new VectorTile(new PbfReader(bytes));
  // Budgeting per candidate name rather than across all combinations: crossing
  // the icon properties with a filter input as varied as `rank` overran a flat
  // cap and dropped whole class values, which read as "every icon resolves".
  const names = keyProperties?.size ? keyProperties : valueProperties;

  for (const [name, layer] of Object.entries(tile.layers)) {
    const observed = sample.layers.get(name) ?? {
      featureCount: 0,
      properties: new Set<string>(),
      valueCombinations: []
    };
    observed.featureCount += layer.length;

    // Combinations are deduplicated across every tile of the source, so a
    // property that varies little stays cheap however many features carry it.
    const seen = new Map<string, SampledFeature>();
    const variants = new Map<string, number>();
    for (const combination of observed.valueCombinations) {
      seen.set(combinationKey(combination), combination);
      const key = nameKey(combination, names);
      variants.set(key, (variants.get(key) ?? 0) + 1);
    }

    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      const properties = feature.properties;
      for (const property of Object.keys(properties)) {
        observed.properties.add(property);
      }
      if (!valueProperties?.size) {
        continue;
      }

      const combination: SampledFeature = {
        properties: {},
        geometryType: feature.type,
        zooms: [zoom]
      };
      for (const property of valueProperties) {
        const value = properties[property];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          combination.properties[property] = value;
        }
      }
      if (Object.keys(combination.properties).length === 0) {
        continue;
      }

      const key = combinationKey(combination);
      const existing = seen.get(key);
      if (existing) {
        // The same values seen at another zoom widen where the combination is
        // known to occur, which is what decides whether a layer's zoom range
        // can ever draw it.
        if (!existing.zooms.includes(zoom)) {
          existing.zooms.push(zoom);
        }
        continue;
      }

      const group = nameKey(combination, names);
      const kept = variants.get(group);
      if (kept === undefined && variants.size >= maxValueKeys) {
        observed.truncatedCombinations = true;
        continue;
      }
      if (kept !== undefined && kept >= maxVariantsPerKey) {
        observed.truncatedCombinations = true;
        continue;
      }

      variants.set(group, (kept ?? 0) + 1);
      seen.set(key, combination);
      observed.valueCombinations.push(combination);
    }

    sample.layers.set(name, observed);
  }
}

/** Identity of a combination: its values and its geometry type, not its zooms. */
function combinationKey(combination: SampledFeature): string {
  return JSON.stringify([combination.geometryType, combination.properties]);
}

/** The candidate name a combination stands for, which retention is budgeted by. */
function nameKey(combination: SampledFeature, names: Set<string> | undefined): string {
  if (!names?.size) {
    return "";
  }
  return JSON.stringify([...names].map((property) => combination.properties[property] ?? null));
}

function decompress(bytes: Uint8Array): Uint8Array {
  // Tile servers commonly return gzipped MVT without a content-encoding header.
  if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return new Uint8Array(gunzipSync(bytes));
  }
  return bytes;
}

function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
  );
  return { x: clampTile(x, scale), y: clampTile(y, scale) };
}

function clampTile(value: number, scale: number): number {
  return Math.max(0, Math.min(scale - 1, value));
}

function clampZoom(zoom: number): number {
  return Math.max(0, Math.min(24, Math.round(zoom)));
}
