import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceContract } from "../src/source-reader.js";

const root = resolve(import.meta.dirname, "../../..");
const pmtiles = resolve(root, "fixtures/generated/basemap.pmtiles");
const mbtiles = resolve(root, "fixtures/generated/basemap.mbtiles");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

const expectedVectorLayers = [
  {
    id: "buildings",
    minzoom: 12,
    maxzoom: 14,
    fields: { height: "Number", name: "String", class: "String" }
  },
  {
    id: "poi",
    minzoom: 0,
    maxzoom: 14,
    fields: { name: "String", class: "String" }
  }
];

describe("readSourceContract", () => {
  it("reads header and vector layers from a PMTiles archive", async () => {
    const contract = await readSourceContract("basemap", pmtiles, 5_000);

    expect(contract).toMatchObject({
      id: "basemap",
      kind: "pmtiles",
      minzoom: 0,
      maxzoom: 14,
      bounds: [-180, -85, 180, 85]
    });
    expect(contract.vectorLayers).toEqual(expectedVectorLayers);
  });

  it("accepts a pmtiles:// prefixed location", async () => {
    const contract = await readSourceContract("basemap", `pmtiles://${pmtiles}`, 5_000);

    expect(contract.kind).toBe("pmtiles");
    expect(contract.vectorLayers.map((layer) => layer.id)).toEqual(["buildings", "poi"]);
  });

  it("reads metadata rows and the json column from an MBTiles database", async () => {
    const contract = await readSourceContract("basemap", mbtiles, 5_000);

    expect(contract).toMatchObject({
      id: "basemap",
      kind: "mbtiles",
      minzoom: 0,
      maxzoom: 14,
      bounds: [-180, -85, 180, 85]
    });
    expect(contract.vectorLayers).toEqual(expectedVectorLayers);
  });

  it("reads TileJSON metadata including tile URLs", async () => {
    const contract = await readSourceContract("openmaptiles", tilejson, 5_000);

    expect(contract).toMatchObject({
      kind: "tilejson",
      minzoom: 0,
      maxzoom: 14,
      tileUrls: ["../generated/tiles/{z}/{x}/{y}.pbf"]
    });
    expect(contract.vectorLayers).toEqual(expectedVectorLayers);
  });

  it("reports every source format with the same vector-layer contract", async () => {
    const [fromPmtiles, fromMbtiles, fromTileJson] = await Promise.all([
      readSourceContract("basemap", pmtiles, 5_000),
      readSourceContract("basemap", mbtiles, 5_000),
      readSourceContract("basemap", tilejson, 5_000)
    ]);

    expect(fromPmtiles.vectorLayers).toEqual(fromMbtiles.vectorLayers);
    expect(fromMbtiles.vectorLayers).toEqual(fromTileJson.vectorLayers);
  });

  it("falls back to an unknown contract for unrecognized locations", async () => {
    const contract = await readSourceContract("basemap", "/tmp/basemap.tiles", 5_000);

    expect(contract).toMatchObject({ kind: "unknown", vectorLayers: [] });
  });

  it("rejects when an MBTiles file does not exist", async () => {
    await expect(
      readSourceContract("basemap", "/tmp/does-not-exist.mbtiles", 5_000)
    ).rejects.toThrow();
  });
});
