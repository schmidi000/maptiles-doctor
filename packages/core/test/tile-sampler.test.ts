import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceContract } from "../src/source-reader.js";
import { sampleAddresses, sampleSourceTiles } from "../src/tile-sampler.js";
import type { SourceContract } from "../src/types.js";

const root = resolve(import.meta.dirname, "../../..");
const pmtiles = resolve(root, "fixtures/generated/basemap.pmtiles");
const mbtiles = resolve(root, "fixtures/generated/basemap.mbtiles");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

const options = { timeoutMs: 5_000, allowNetwork: true };

describe("sampleAddresses", () => {
  // The centre of a world tileset's bounds is open ocean, so probing there read
  // a tile with no features and left every data-driven check unverifiable; see
  // validation/FINDINGS.md.
  it("probes each zoom at a different populated anchor", () => {
    const addresses = sampleAddresses(
      { id: "a", location: "a", kind: "pmtiles", vectorLayers: [], minzoom: 0, maxzoom: 14 },
      3
    );

    // London, then New York, then Tokyo.
    expect(addresses).toEqual([
      { z: 0, x: 0, y: 0 },
      { z: 7, x: 37, y: 48 },
      { z: 14, x: 14549, y: 6451 }
    ]);
  });

  // The generator writes tiles at exactly the addresses the sampler probes. If
  // the anchors move without it following, every fixture sample comes back
  // empty, which is a confusing failure to debug from the other end.
  it("agrees with the addresses the fixture generator writes", async () => {
    const { directoryTiles } = await import("../../../scripts/build-fixtures.mjs");
    const addresses = sampleAddresses(
      { id: "a", location: "a", kind: "pmtiles", vectorLayers: [], minzoom: 0, maxzoom: 14 },
      3
    );

    const written = new Set(directoryTiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`));
    for (const address of addresses) {
      expect([...written]).toContain(`${address.z}/${address.x}/${address.y}`);
    }
  });

  it("falls back to the bounds centre when no anchor lies inside them", () => {
    const [address] = sampleAddresses(
      {
        id: "a",
        location: "a",
        kind: "pmtiles",
        vectorLayers: [],
        minzoom: 4,
        maxzoom: 4,
        bounds: [10, 45, 20, 55]
      },
      1
    );

    // Center 15E/50N at zoom 4 is column 8, row 5.
    expect(address).toEqual({ z: 4, x: 8, y: 5 });
  });

  it("uses an anchor inside a regional bounding box rather than its centre", () => {
    const [address] = sampleAddresses(
      {
        id: "a",
        location: "a",
        kind: "pmtiles",
        vectorLayers: [],
        minzoom: 10,
        maxzoom: 10,
        // Great Britain: the centre is farmland, London is not.
        bounds: [-8, 50, 2, 59]
      },
      1
    );

    expect(address).toEqual({ z: 10, x: 511, y: 340 });
  });

  it("honours an explicit sample location over the anchors", () => {
    const addresses = sampleAddresses(
      { id: "a", location: "a", kind: "pmtiles", vectorLayers: [], minzoom: 6, maxzoom: 6 },
      3,
      [13.405, 52.52]
    );

    expect(addresses).toEqual([{ z: 6, x: 34, y: 20 }]);
  });

  it("collapses to a single address when the source has one zoom level", () => {
    const addresses = sampleAddresses(
      { id: "a", location: "a", kind: "mbtiles", vectorLayers: [], minzoom: 6, maxzoom: 6 },
      3
    );

    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.z).toBe(6);
  });
});

describe("sampleSourceTiles", () => {
  it("reads layers and feature properties from a PMTiles archive", async () => {
    const contract = await readSourceContract("basemap", pmtiles, 5_000);
    const sample = await sampleSourceTiles(contract, options);

    expect(sample.retrieved.map((address) => address.z)).toEqual([0, 14]);
    expect([...sample.layers.keys()].sort()).toEqual(["buildings", "poi"]);
    expect([...(sample.layers.get("buildings")?.properties ?? [])].sort()).toEqual([
      "height",
      "name"
    ]);
    expect(sample.layers.get("buildings")?.featureCount).toBe(4);
    expect(sample.failures).toEqual([]);
  });

  it("reads the same observations from an MBTiles database", async () => {
    const contract = await readSourceContract("basemap", mbtiles, 5_000);
    const sample = await sampleSourceTiles(contract, options);

    expect([...sample.layers.keys()].sort()).toEqual(["buildings", "poi"]);
    expect([...(sample.layers.get("poi")?.properties ?? [])].sort()).toEqual(["class", "name"]);
  });

  it("reads a tile directory declared by a TileJSON template", async () => {
    const contract = await readSourceContract("openmaptiles", tilejson, 5_000);
    const sample = await sampleSourceTiles(contract, options);

    expect(sample.retrieved).toHaveLength(3);
    expect([...sample.layers.keys()].sort()).toEqual(["buildings", "poi"]);
  });

  it("reports no retrieved tiles when the addresses hold nothing", async () => {
    const contract = await readSourceContract(
      "basemap",
      resolve(root, "fixtures/empty-tiles/tilejson.json"),
      5_000
    );
    const sample = await sampleSourceTiles(contract, options);

    expect(sample.attempted).toHaveLength(3);
    expect(sample.retrieved).toHaveLength(0);
    expect(sample.failures).toEqual([]);
    expect(sample.layers.size).toBe(0);
  });

  it("skips a remote source when network access is disabled", async () => {
    const contract: SourceContract = {
      id: "basemap",
      location: "https://tiles.invalid.test/basemap.pmtiles",
      kind: "pmtiles",
      vectorLayers: [],
      minzoom: 0,
      maxzoom: 2
    };

    const sample = await sampleSourceTiles(contract, { ...options, allowNetwork: false });

    expect(sample.skipped).toBe("Network access is disabled.");
    expect(sample.attempted).toEqual([]);
  });

  it("skips sources it cannot sample", async () => {
    const sample = await sampleSourceTiles(
      { id: "basemap", location: "/tmp/basemap.tiles", kind: "unknown", vectorLayers: [] },
      options
    );

    expect(sample.skipped).toContain("unknown");
  });

  it("skips a TileJSON without a tile template", async () => {
    const sample = await sampleSourceTiles(
      { id: "basemap", location: "/tmp/tiles.json", kind: "tilejson", vectorLayers: [] },
      options
    );

    expect(sample.skipped).toContain("no tile URL template");
  });

  it("limits the number of probed addresses", async () => {
    const contract = await readSourceContract("basemap", pmtiles, 5_000);
    const sample = await sampleSourceTiles(contract, { ...options, maxTiles: 1 });

    expect(sample.attempted).toHaveLength(1);
  });
});
