// Generates the binary tile fixtures (PMTiles v3, MBTiles) used by the test
// suite. Binary artifacts are not committed; run `npm run fixtures:build` or let
// the vitest global setup build them into `fixtures/generated/`.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { PbfWriter } from "pbf";
import { zxyToTileId } from "pmtiles";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const generatedDir = resolve(root, "fixtures/generated");
export const pmtilesFixture = resolve(generatedDir, "basemap.pmtiles");
export const mbtilesFixture = resolve(generatedDir, "basemap.mbtiles");
export const unlabeledPmtilesFixture = resolve(generatedDir, "basemap-no-metadata.pmtiles");
export const tileDirectory = resolve(generatedDir, "tiles");

// Kept in sync with fixtures/simple-style/tilejson.json so the same style
// fixtures can be pointed at any of the three source formats. `class` is
// declared for `buildings` but never carried by a sampled feature, which is the
// drift the tile sampler exists to catch.
const vectorLayers = [
  {
    id: "buildings",
    fields: { height: "Number", name: "String", class: "String" },
    minzoom: 12,
    maxzoom: 14
  },
  {
    id: "poi",
    fields: { name: "String", class: "String" },
    minzoom: 0,
    maxzoom: 14
  }
];

const sampleLayers = [
  {
    name: "buildings",
    features: [
      { properties: { height: 12, name: "Fixture Hall" } },
      { properties: { height: 30, name: "Fixture Tower" } }
    ]
  },
  {
    // Two classes, so a data-driven `icon-image` built from `class` produces one
    // name the sprite has and one it does not.
    name: "poi",
    features: [
      { properties: { name: "Fixture Cafe", class: "cafe" } },
      { properties: { name: "Fixture Bar", class: "bar" } }
    ]
  }
];

// The addresses the sampler probes for a world-bounds source: one populated
// anchor per zoom, London then New York then Tokyo. `sampleAddresses` owns that
// choice, and packages/core/test/tile-sampler.test.ts asserts these match, so a
// change there fails loudly here rather than silently emptying every fixture.
const sampleTiles = [
  { z: 0, x: 0, y: 0 },
  { z: 14, x: 14549, y: 6451 }
];

// The tile directory additionally carries the mid zoom, so a TileJSON pointing
// at it can be sampled at every address the sampler probes.
export const directoryTiles = [...sampleTiles, { z: 7, x: 37, y: 48 }];

const bounds = { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 };
const minZoom = 0;
const maxZoom = 14;

export async function buildBinaryFixtures() {
  await mkdir(generatedDir, { recursive: true });
  await Promise.all([
    buildPmtiles(pmtilesFixture, { name: "fixture-basemap", vector_layers: vectorLayers }),
    buildPmtiles(unlabeledPmtilesFixture, { name: "fixture-basemap-no-metadata" }),
    buildMbtiles(mbtilesFixture),
    buildTileDirectory()
  ]);
  return { pmtilesFixture, mbtilesFixture, unlabeledPmtilesFixture, tileDirectory };
}

async function buildTileDirectory() {
  for (const tile of directoryTiles) {
    const directory = resolve(tileDirectory, String(tile.z), String(tile.x));
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${tile.y}.pbf`), gzipSync(encodeTile()));
  }
}

async function buildPmtiles(target, metadataObject) {
  const tiles = sampleTiles
    .map((tile) => ({ ...tile, tileId: zxyToTileId(tile.z, tile.x, tile.y), data: encodeTile() }))
    .sort((a, b) => a.tileId - b.tileId);

  const tileData = Buffer.concat(tiles.map((tile) => gzipSync(tile.data)));
  const metadata = gzipSync(Buffer.from(JSON.stringify(metadataObject), "utf8"));

  let offset = 0;
  const entries = tiles.map((tile) => {
    const length = gzipSync(tile.data).length;
    const entry = { tileId: tile.tileId, offset, length, runLength: 1 };
    offset += length;
    return entry;
  });
  const rootDirectory = gzipSync(serializeDirectory(entries));

  const headerLength = 127;
  const rootOffset = headerLength;
  const metadataOffset = rootOffset + rootDirectory.length;
  const leafOffset = metadataOffset + metadata.length;
  const tileDataOffset = leafOffset;

  const header = Buffer.alloc(headerLength);
  header.write("PMTiles", 0, "utf8");
  header.writeUInt8(3, 7);
  writeUInt64(header, rootOffset, 8);
  writeUInt64(header, rootDirectory.length, 16);
  writeUInt64(header, metadataOffset, 24);
  writeUInt64(header, metadata.length, 32);
  writeUInt64(header, leafOffset, 40);
  writeUInt64(header, 0, 48);
  writeUInt64(header, tileDataOffset, 56);
  writeUInt64(header, tileData.length, 64);
  writeUInt64(header, entries.length, 72); // addressed tiles
  writeUInt64(header, entries.length, 80); // tile entries
  writeUInt64(header, entries.length, 88); // tile contents
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(2, 97); // internal compression: gzip
  header.writeUInt8(2, 98); // tile compression: gzip
  header.writeUInt8(1, 99); // tile type: mvt
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  header.writeInt32LE(e7(bounds.minLon), 102);
  header.writeInt32LE(e7(bounds.minLat), 106);
  header.writeInt32LE(e7(bounds.maxLon), 110);
  header.writeInt32LE(e7(bounds.maxLat), 114);
  header.writeUInt8(0, 118); // center zoom
  header.writeInt32LE(0, 119);
  header.writeInt32LE(0, 123);

  await writeFile(target, Buffer.concat([header, rootDirectory, metadata, tileData]));
}

async function buildMbtiles(target) {
  await rm(target, { force: true });
  const database = new Database(target);
  try {
    database.exec(
      "create table metadata (name text, value text);" +
        "create table tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);"
    );
    const insert = database.prepare("insert into metadata (name, value) values (?, ?)");
    const rows = [
      ["name", "fixture-basemap"],
      ["format", "pbf"],
      ["minzoom", String(minZoom)],
      ["maxzoom", String(maxZoom)],
      ["bounds", `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`],
      ["json", JSON.stringify({ vector_layers: vectorLayers })]
    ];
    database.transaction(() => {
      for (const [name, value] of rows) {
        insert.run(name, value);
      }
    })();

    const insertTile = database.prepare("insert into tiles values (?, ?, ?, ?)");
    database.transaction(() => {
      for (const tile of sampleTiles) {
        // MBTiles rows are TMS, so the y axis is flipped relative to XYZ.
        const tmsRow = 2 ** tile.z - 1 - tile.y;
        insertTile.run(tile.z, tile.x, tmsRow, gzipSync(encodeTile()));
      }
    })();
  } finally {
    database.close();
  }
}

// Minimal Mapbox Vector Tile writer (vector_tile.proto): Tile.layers = 3,
// Layer{name=1, features=2, keys=3, values=4, extent=5, version=15}.
function encodeTile() {
  return encodeTileFrom(sampleLayers);
}

/**
 * Encodes arbitrary layers as an MVT. Exported so a test can build a tile with
 * shapes the shared fixtures do not carry — a source-layer crowded enough to
 * exercise the sampler's retention budget — without perturbing every fixture
 * that reads the standard one.
 */
export function encodeTileFrom(layers) {
  const writer = new PbfWriter();
  for (const layer of layers) {
    writer.writeMessage(3, writeLayer, layer);
  }
  return Buffer.from(writer.finish());
}

function writeLayer(layer, pbf) {
  const keys = [];
  const values = [];
  const keyIndex = new Map();
  const valueIndex = new Map();

  const features = layer.features.map((feature, index) => {
    const tags = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!keyIndex.has(key)) {
        keyIndex.set(key, keys.length);
        keys.push(key);
      }
      const valueKey = `${typeof value}:${value}`;
      if (!valueIndex.has(valueKey)) {
        valueIndex.set(valueKey, values.length);
        values.push(value);
      }
      tags.push(keyIndex.get(key), valueIndex.get(valueKey));
    }
    return { id: index + 1, tags };
  });

  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, layer.name);
  for (const feature of features) {
    pbf.writeMessage(2, writeFeature, feature);
  }
  for (const key of keys) {
    pbf.writeStringField(3, key);
  }
  for (const value of values) {
    pbf.writeMessage(4, writeValue, value);
  }
  pbf.writeVarintField(5, 4096);
}

function writeFeature(feature, pbf) {
  pbf.writeVarintField(1, feature.id);
  pbf.writePackedVarint(2, feature.tags);
  pbf.writeVarintField(3, 1); // POINT
  // MoveTo command with a count of 1, then a zig-zag encoded point.
  pbf.writePackedVarint(4, [9, 2048, 2048]);
}

function writeValue(value, pbf) {
  if (typeof value === "string") {
    pbf.writeStringField(1, value);
    return;
  }
  if (typeof value === "boolean") {
    pbf.writeBooleanField(7, value);
    return;
  }
  pbf.writeDoubleField(3, value);
}

function serializeDirectory(entries) {
  const parts = [varint(entries.length)];

  let lastId = 0;
  for (const entry of entries) {
    parts.push(varint(entry.tileId - lastId));
    lastId = entry.tileId;
  }
  for (const entry of entries) {
    parts.push(varint(entry.runLength));
  }
  for (const entry of entries) {
    parts.push(varint(entry.length));
  }
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    const contiguous = previous && entry.offset === previous.offset + previous.length;
    parts.push(varint(contiguous ? 0 : entry.offset + 1));
  }

  return Buffer.concat(parts);
}

function varint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function writeUInt64(buffer, value, offset) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function e7(value) {
  return Math.round(value * 10_000_000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const built = await buildBinaryFixtures();
  for (const path of Object.values(built)) {
    console.log(`Built ${path}`);
  }
}
