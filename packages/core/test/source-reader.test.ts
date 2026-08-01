import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// Format was decided by matching `.pmtiles` against the whole location string,
// which a signed URL never ends with. The archive went to the TileJSON reader
// and a binary file was parsed as JSON.
describe("readSourceContract over HTTP", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const archive = await readFile(pmtiles);
    server = createServer((request, response) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (!range) {
        response.writeHead(200, { "content-length": String(archive.length) });
        response.end(archive);
        return;
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), archive.length - 1);
      response.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${archive.length}`,
        "content-length": String(end - start + 1)
      });
      response.end(archive.subarray(start, end + 1));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("reads a PMTiles archive served with a query string", async () => {
    const contract = await readSourceContract(
      "basemap",
      `${origin}/basemap.pmtiles?token=abc123&expires=1`,
      5_000
    );

    expect(contract).toMatchObject({ kind: "pmtiles", minzoom: 0, maxzoom: 14 });
    expect(contract.vectorLayers).toEqual(expectedVectorLayers);
  });

  it("keeps the query string on the location it requests", async () => {
    const contract = await readSourceContract(
      "basemap",
      `${origin}/basemap.pmtiles?token=abc123`,
      5_000
    );

    expect(contract.location).toBe(`${origin}/basemap.pmtiles?token=abc123`);
  });

  it("still reads a PMTiles archive behind a fragment", async () => {
    const contract = await readSourceContract("basemap", `${origin}/basemap.pmtiles#v2`, 5_000);

    expect(contract.kind).toBe("pmtiles");
  });
});
