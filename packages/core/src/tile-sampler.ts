import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { isHttpUrl, readRemoteBytes, resolveLocation } from "./io.js";
import { openMbtiles, openPmtiles } from "./source-reader.js";
import type { SourceContract, TileAddress, TileSample } from "./types.js";

export interface SampleOptions {
  timeoutMs: number;
  allowNetwork: boolean;
  maxTiles?: number;
  /**
   * Properties an `icon-image` builds a name from. Their values are recorded per
   * feature so the names a style really produces can be enumerated. Nothing is
   * recorded when this is empty, which is the common case.
   */
  valueProperties?: Set<string> | undefined;
  /** Longitude and latitude to sample at, overriding the built-in anchors. */
  sampleAt?: [number, number] | undefined;
}

/**
 * Enough distinct combinations to find a missing icon without holding a tile's
 * worth of strings. A source-layer with more variety than this is sampled, not
 * enumerated, and says so through `truncatedCombinations`.
 */
const maxValueCombinations = 200;

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
      mergeTile(sample, bytes, options.valueProperties);
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

  const zooms = new Set<number>([minzoom, maxzoom]);
  if (maxTiles > 2 && maxzoom > minzoom) {
    zooms.add(Math.floor((minzoom + maxzoom) / 2));
  }

  // Each zoom takes a different anchor, so a run that probes three tiles looks
  // at three places rather than three scales of one.
  return [...zooms]
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, maxTiles))
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

  if (isHttpUrl(target)) {
    const bytes = await readRemoteBytes(target, timeoutMs);
    return bytes ? decompress(bytes) : undefined;
  }

  // A tile template can also point at a directory of tiles on disk, resolved
  // relative to the TileJSON that declared it.
  return readLocalTile(resolveLocation(target, dirname(contract.location)));
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
  valueProperties: Set<string> | undefined
): void {
  const tile = new VectorTile(new PbfReader(bytes));

  for (const [name, layer] of Object.entries(tile.layers)) {
    const observed = sample.layers.get(name) ?? {
      featureCount: 0,
      properties: new Set<string>(),
      valueCombinations: []
    };
    observed.featureCount += layer.length;

    // Combinations are deduplicated across every tile of the source, so a
    // property that varies little stays cheap however many features carry it.
    const seen = new Set(
      observed.valueCombinations.map((combination) => JSON.stringify(combination))
    );

    for (let index = 0; index < layer.length; index += 1) {
      const properties = layer.feature(index).properties;
      for (const property of Object.keys(properties)) {
        observed.properties.add(property);
      }
      if (!valueProperties?.size) {
        continue;
      }

      const combination: Record<string, string> = {};
      for (const property of valueProperties) {
        const value = properties[property];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          combination[property] = String(value);
        }
      }
      if (Object.keys(combination).length === 0) {
        continue;
      }

      const key = JSON.stringify(combination);
      if (seen.has(key)) {
        continue;
      }
      if (observed.valueCombinations.length >= maxValueCombinations) {
        observed.truncatedCombinations = true;
        continue;
      }
      seen.add(key);
      observed.valueCombinations.push(combination);
    }

    sample.layers.set(name, observed);
  }
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
