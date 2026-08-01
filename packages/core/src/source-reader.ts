import { open } from "node:fs/promises";
import type DatabaseConstructor from "better-sqlite3";
import { FetchSource, PMTiles, type RangeResponse, type Source } from "pmtiles";
import type { SourceContract, VectorLayerContract } from "./types.js";
import { isHttpUrl, readJson } from "./io.js";

export async function readSourceContract(
  id: string,
  location: string,
  timeoutMs: number
): Promise<SourceContract> {
  const path = locationPath(location).toLowerCase();

  if (path.endsWith(".pmtiles") || location.startsWith("pmtiles://")) {
    return readPmtilesSource(id, location, timeoutMs);
  }

  if (path.endsWith(".mbtiles")) {
    return readMbtilesSource(id, location);
  }

  if (path.endsWith(".json") || isHttpUrl(location)) {
    return readTileJsonSource(id, location, timeoutMs);
  }

  return {
    id,
    location,
    kind: "unknown",
    vectorLayers: []
  };
}

/**
 * The path part of a location, which is what names its format. A signed archive
 * arrives as `https://host/world.pmtiles?token=…`, and matching `.pmtiles`
 * against the whole string misses it, sending a binary archive to the TileJSON
 * reader to be parsed as JSON. The full location is still what gets requested.
 */
function locationPath(location: string): string {
  const normalized = location.startsWith("pmtiles://")
    ? location.slice("pmtiles://".length)
    : location;
  if (!isHttpUrl(normalized)) {
    return normalized;
  }
  try {
    return new URL(normalized).pathname;
  } catch {
    return normalized;
  }
}

export function openPmtiles(location: string, timeoutMs: number): PMTiles {
  const normalized = location.startsWith("pmtiles://")
    ? location.slice("pmtiles://".length)
    : location;
  const source: Source = isHttpUrl(normalized)
    ? new FetchSource(normalized)
    : new LocalFileSource(normalized);
  return new PMTiles(new TimeoutSource(source, timeoutMs));
}

async function readPmtilesSource(
  id: string,
  location: string,
  timeoutMs: number
): Promise<SourceContract> {
  const pmtiles = openPmtiles(location, timeoutMs);
  const [header, metadata] = await Promise.all([pmtiles.getHeader(), pmtiles.getMetadata()]);
  const metadataRecord = asRecord(metadata);
  return {
    id,
    location,
    kind: "pmtiles",
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    vectorLayers: parseVectorLayers(metadataRecord?.vector_layers),
    tileUrls: []
  };
}

/**
 * better-sqlite3 is a native module, so it cannot be bundled into the GitHub
 * Action. Loading it lazily lets every other source format work in environments
 * where the binding is missing, and turns MBTiles into an explicit failure.
 */
export async function openMbtiles(location: string): Promise<DatabaseConstructor.Database> {
  let Database: typeof DatabaseConstructor;
  try {
    ({ default: Database } = await import("better-sqlite3"));
  } catch {
    throw new Error(
      "MBTiles support requires the better-sqlite3 native module, which is not available in this environment."
    );
  }
  return new Database(location, { readonly: true, fileMustExist: true });
}

async function readMbtilesSource(id: string, location: string): Promise<SourceContract> {
  const database = await openMbtiles(location);
  try {
    const rows = database.prepare("select name, value from metadata").all() as Array<{
      name: string;
      value: string;
    }>;
    const metadata = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    return {
      id,
      location,
      kind: "mbtiles",
      minzoom: numberFrom(metadata.minzoom),
      maxzoom: numberFrom(metadata.maxzoom),
      bounds: boundsFrom(metadata.bounds),
      vectorLayers: parseVectorLayers(parseJsonMaybe(metadata.json)?.vector_layers),
      tileUrls: []
    };
  } finally {
    database.close();
  }
}

async function readTileJsonSource(
  id: string,
  location: string,
  timeoutMs: number
): Promise<SourceContract> {
  const tileJson = await readJson<Record<string, unknown>>(location, timeoutMs);
  return {
    id,
    location,
    kind: "tilejson",
    minzoom: numberFrom(tileJson.minzoom),
    maxzoom: numberFrom(tileJson.maxzoom),
    bounds: boundsFrom(tileJson.bounds),
    vectorLayers: parseVectorLayers(tileJson.vector_layers),
    glyphs: typeof tileJson.glyphs === "string" ? tileJson.glyphs : undefined,
    sprite: typeof tileJson.sprite === "string" ? tileJson.sprite : undefined,
    tileUrls: Array.isArray(tileJson.tiles)
      ? tileJson.tiles.filter((item): item is string => typeof item === "string")
      : []
  };
}

/**
 * A style source that declares `tiles` inline is already a TileJSON in every way
 * that matters: it carries the templates, the zoom range, the bounds, and
 * sometimes `vector_layers`. Its contract is read from the style object rather
 * than fetched, because the only URL available is a `{z}/{x}/{y}` template, and
 * requesting that verbatim asks a tile server for a tile named `{z}` — a 404 or
 * 500 that reads as a dead source and silences every check depending on it.
 *
 * `location` is the style's own path, so relative tile templates resolve against
 * the file that declared them.
 */
export function inlineSourceContract(
  id: string,
  source: unknown,
  location: string
): SourceContract {
  const record = asRecord(source) ?? {};
  const tiles = Array.isArray(record.tiles)
    ? record.tiles.filter((item): item is string => typeof item === "string")
    : [];
  // Only vector tiles can be parsed for layers and properties. A raster source
  // is real and its zoom range still checks, but sampling it as MVT is
  // meaningless.
  const vector = record.type === undefined || record.type === "vector";

  return {
    id,
    location,
    kind: vector ? "tilejson" : "raster",
    minzoom: numberFrom(record.minzoom),
    maxzoom: numberFrom(record.maxzoom),
    bounds: boundsFrom(record.bounds),
    vectorLayers: parseVectorLayers(record.vector_layers),
    tileUrls: tiles
  };
}

function parseVectorLayers(value: unknown): VectorLayerContract[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): VectorLayerContract[] => {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string") {
      return [];
    }
    return [
      {
        id: record.id,
        minzoom: numberFrom(record.minzoom),
        maxzoom: numberFrom(record.maxzoom),
        fields: parseFields(record.fields)
      }
    ];
  });
}

function parseFields(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, fieldValue]) => [key, String(fieldValue)])
  );
}

function parseJsonMaybe(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boundsFrom(value: unknown): [number, number, number, number] | undefined {
  if (Array.isArray(value) && value.length === 4) {
    const parsed = value.map(Number);
    if (parsed.every(Number.isFinite)) {
      return parsed as [number, number, number, number];
    }
  }

  if (typeof value === "string") {
    const parsed = value.split(",").map(Number);
    if (parsed.length === 4 && parsed.every(Number.isFinite)) {
      return parsed as [number, number, number, number];
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Applies the configured timeout to every PMTiles range read. The library takes
 * an `AbortSignal` on `getZxy` but not on `getHeader` or `getMetadata`, and
 * `FetchSource` has nowhere to put a default one, so a remote archive's header,
 * directory, and metadata requests ran with no deadline at all — a hung host
 * stalled the whole check indefinitely. Wrapping the `Source` is the one place
 * that covers all four kinds of read.
 */
class TimeoutSource implements Source {
  constructor(
    private readonly inner: Source,
    private readonly timeoutMs: number
  ) {}

  getKey(): string {
    return this.inner.getKey();
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    // A caller-supplied signal still has to win, so the two are combined rather
    // than replaced.
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.inner.getBytes(offset, length, combined, etag);
  }
}

class LocalFileSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  /**
   * Reads only the requested range. PMTiles is built around small header,
   * directory, metadata, and tile reads, so `readFile` of the whole archive per
   * range allocated it many times over — fine for a fixture, an out-of-memory
   * failure on a multi-gigabyte production archive.
   */
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
      };
    } finally {
      await handle.close();
    }
  }
}
