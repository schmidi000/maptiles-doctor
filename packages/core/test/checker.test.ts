import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStyleContract } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

function fixture(name: string): string {
  return resolve(root, "fixtures", name, "style.json");
}

const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Binds and immediately releases a port so connecting to it is refused at once.
 * Depending on a hostname failing to resolve makes the timing environmental.
 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((closed, failed) =>
    server.close((error) => (error ? failed(error) : closed()))
  );
  return port;
}

async function writeTempStyle(name: string, style: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maptiles-doctor-checker-"));
  tempDirs.push(dir);
  const stylePath = join(dir, `${name}.json`);
  await writeFile(stylePath, JSON.stringify(style));
  return stylePath;
}

describe("checkStyleContract", () => {
  it("passes a matching fixture style", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("simple-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.status).toBe("passed");
    expect(report.findings).toHaveLength(0);
    expect(report.incompleteChecks).toHaveLength(0);
    expect(report.schemaVersion).toBe("1.0");
    expect(report.checks.map((check) => check.id)).toEqual([
      "style-spec",
      "tile-sample",
      "source-layer",
      "assets"
    ]);
  });

  // No zoom finding is expected here: 3d-buildings draws at 12-15 against a
  // source that stops at 14, which is overzoom and therefore fine. Zoom has its
  // own fixtures in zoom-mismatch and zoom-overzoom.
  it("reports missing source-layer, missing icon, and property risk", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.status).toBe("failed");
    expect(report.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining(["source-layer", "icon", "expression-property"])
    );
    expect(report.findings.find((finding) => finding.category === "source-layer")?.suggestion).toBe(
      "buildings"
    );
  });

  it("reports the available source-layers as evidence for a missing one", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    const finding = report.findings.find((item) => item.category === "source-layer");
    expect(finding?.severity).toBe("broken");
    expect(finding?.layerId).toBe("3d-buildings");
    expect(finding?.evidence).toEqual({ availableSourceLayers: ["buildings", "poi"] });
  });

  it("lists the declared fields for a property missing from source-layer metadata", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    const finding = report.findings.find(
      (item) => item.category === "expression-property" && item.property === "missing_name"
    );
    expect(finding?.severity).toBe("risky");
    expect(finding?.sourceLayer).toBe("poi");
    expect(finding?.evidence).toEqual({
      fields: ["name", "class"],
      sampledProperties: ["name", "class"]
    });
    // "missing_name" is too far from any declared field to suggest one.
    expect(finding?.suggestion).toBeUndefined();
  });

  it("marks a layer as broken when it ends below the source minzoom", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("zoom-mismatch"),
      sampleTiles: false
    });

    expect(report.status).toBe("failed");
    expect(report.findings.filter((finding) => finding.category === "zoom")).toHaveLength(2);
    expect(
      report.findings.find((finding) => finding.layerId === "buildings-below-source")
    ).toMatchObject({
      id: "layer.buildings-below-source.zoom-below-source",
      severity: "broken",
      category: "zoom",
      evidence: { layerMin: 0, layerMax: 5, sourceMin: 8, sourceMax: 14 }
    });
  });

  it("marks a layer as risky when it starts below the source minzoom but overlaps it", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("zoom-mismatch"),
      sampleTiles: false
    });

    expect(
      report.findings.find((finding) => finding.layerId === "buildings-starting-below-source")
    ).toMatchObject({
      id: "layer.buildings-starting-below-source.zoom-starts-below-source",
      severity: "risky",
      category: "zoom",
      evidence: { layerMin: 2, layerMax: 12, sourceMin: 8, sourceMax: 14 }
    });
  });

  // MapLibre scales the deepest tiles a source has rather than dropping the
  // layer, so drawing above the source maxzoom is the normal way to get detail
  // at high zoom. Reporting it made 150 findings against four production styles
  // that render correctly; see validation/FINDINGS.md.
  it("does not report a layer that draws above the source maxzoom", async () => {
    const report = await checkStyleContract({ stylePath: fixture("zoom-overzoom") });

    expect(report.findings.filter((finding) => finding.category === "zoom")).toEqual([]);
  });

  // A source that declares `tiles` inline offers only a {z}/{x}/{y} template as
  // a URL. Fetching that verbatim asked a tile server for a tile named `{z}`,
  // and the resulting 404 silenced every check for the source; see
  // validation/FINDINGS.md.
  describe("sources that declare tiles inline", () => {
    async function inlineTiles() {
      return checkStyleContract({ stylePath: fixture("inline-tiles-style") });
    }

    it("reads the contract from the style instead of fetching the template", async () => {
      const report = await inlineTiles();

      expect(report.incompleteChecks.filter((item) => item.id.includes("openmaptiles"))).toEqual(
        []
      );
    });

    it("checks source-layers against the tiles the template really serves", async () => {
      const report = await inlineTiles();

      expect(
        report.findings.find((item) => item.id === "layer.not-in-any-tile.source-layer-not-sampled")
      ).toMatchObject({ severity: "info", category: "source-layer" });
      // The source-layer that is present must not be reported.
      expect(report.findings.filter((item) => item.layerId === "buildings")).toEqual([]);
    });

    it("does not sample a raster source as vector tiles", async () => {
      const report = await inlineTiles();

      expect(
        report.incompleteChecks.find((item) => item.id === "source.hillshade.tile-sample-skipped")
      ).toMatchObject({ message: expect.stringContaining("no vector layers") });
      expect(report.findings.filter((item) => item.sourceId === "hillshade")).toEqual([]);
    });
  });

  it("flags a layer that references an undeclared source and suggests the nearest id", async () => {
    const report = await checkStyleContract({ stylePath: fixture("missing-source") });

    const finding = report.findings.find((item) => item.id === "layer.buildings.missing-source");
    expect(finding).toMatchObject({
      severity: "broken",
      category: "source",
      sourceId: "openmaptile",
      suggestion: "openmaptiles"
    });
  });

  it("reports style specification errors as broken findings", async () => {
    const report = await checkStyleContract({ stylePath: fixture("invalid-style") });

    expect(report.status).toBe("failed");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "style-spec.invalid", severity: "broken", path: "style" })
    ]);
    expect(report.checks.find((check) => check.id === "style-spec")?.status).toBe("failed");
  });

  it("warns about an unused source override without failing the run", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("simple-style"),
      sources: [{ id: "ghost", location: tilejson }]
    });

    expect(report.status).toBe("passed");
    expect(report.summary).toMatchObject({ broken: 0, risky: 0, warning: 1, incomplete: 0 });
    expect(report.findings[0]).toMatchObject({
      id: "source.ghost.unused",
      severity: "warning",
      category: "source"
    });
  });

  it("fails when a finding reaches a lowered fail threshold", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("simple-style"),
      sources: [{ id: "ghost", location: tilejson }],
      failThreshold: "warning"
    });

    expect(report.status).toBe("failed");
  });

  it("records an incomplete check when a source has no inspectable location", async () => {
    const report = await checkStyleContract({ stylePath: fixture("no-source-location") });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toHaveLength(0);
    expect(report.incompleteChecks).toEqual([
      expect.objectContaining({
        id: "source.openmaptiles.metadata-missing",
        category: "source",
        sourceId: "openmaptiles"
      })
    ]);
  });

  it("records an incomplete check when a remote source cannot be reached", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/tiles.json`;
    const stylePath = await writeTempStyle("unreachable", {
      version: 8,
      sources: { openmaptiles: { type: "vector", url } },
      layers: [
        {
          id: "buildings",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "buildings",
          paint: { "fill-color": "#cccccc" }
        }
      ]
    });

    const report = await checkStyleContract({ stylePath, timeoutMs: 2_000 });

    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks).toEqual([
      expect.objectContaining({
        id: "source.openmaptiles.read-failed",
        category: "source",
        path: url
      })
    ]);
  });

  it("hashes the local style and source artifacts it inspected", async () => {
    const stylePath = fixture("simple-style");
    const report = await checkStyleContract({
      stylePath,
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.artifactHashes[stylePath]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.artifactHashes[tilejson]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("verifies a style against every source format the same way", async () => {
    const [fromPmtiles, fromMbtiles] = await Promise.all([
      checkStyleContract({ stylePath: fixture("pmtiles-style") }),
      checkStyleContract({ stylePath: fixture("mbtiles-style") })
    ]);

    expect(fromPmtiles.status).toBe("passed");
    expect(fromMbtiles.status).toBe("passed");
    expect(fromPmtiles.checks.find((check) => check.id === "tile-sample")?.status).toBe("passed");
  });

  it("checks supplied style text instead of the file, resolving paths from it", async () => {
    const stylePath = fixture("simple-style");
    const edited = (await readFile(stylePath, "utf8")).replace(
      '"source-layer": "buildings"',
      '"source-layer": "building"'
    );

    const report = await checkStyleContract({ stylePath, styleText: edited });

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ id: "layer.buildings.missing-source-layer" })
    );
    // The style's own relative source location still resolved, so the check ran
    // against the real tileset.
    expect(report.incompleteChecks).toHaveLength(0);
    // Nothing on disk matches what was checked, so nothing is attributed to it.
    expect(report.artifactHashes[stylePath]).toBeUndefined();
  });

  it("reports unparsable style text as an error rather than an empty report", async () => {
    await expect(
      checkStyleContract({ stylePath: fixture("simple-style"), styleText: '{ "layers": [ }' })
    ).rejects.toThrow(/Style is not valid JSON/);
  });

  it("prefers an explicit source override over the location declared in the style", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("remote-source"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.status).toBe("passed");
    expect(report.incompleteChecks).toHaveLength(0);
  });
});

describe("tile sampling", () => {
  it("notes a property that metadata declares but no sampled feature carries", async () => {
    const report = await checkStyleContract({ stylePath: fixture("stale-metadata") });

    expect(report.status).toBe("passed");
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "layer.buildings-by-class.property.class.not-sampled",
        severity: "info",
        category: "expression-property",
        property: "class"
      })
    ]);
    expect(report.findings[0]?.evidence).toEqual({
      sampledProperties: ["height", "name"],
      sampledFeatures: 4
    });
  });

  it("drops the sampled-only finding when sampling is disabled", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("stale-metadata"),
      sampleTiles: false
    });

    expect(report.findings).toHaveLength(0);
    expect(report.checks.find((check) => check.id === "tile-sample")?.status).toBe("incomplete");
  });

  it("falls back to sampled layers when a source declares no vector layers", async () => {
    const report = await checkStyleContract({ stylePath: fixture("unlabeled-source") });

    // Without metadata, a partial sample is suspicion, not proof: nothing is broken.
    expect(report.summary.broken).toBe(0);
    expect(report.findings.map((finding) => finding.id)).toEqual([
      "layer.waterways.source-layer-not-sampled",
      "layer.buildings-by-operator.property.operator.not-observed"
    ]);
    expect(report.findings[0]).toMatchObject({
      // Three tiles will not contain a rare source-layer even in a healthy
      // tileset, so absence from them defaults to info.
      severity: "info",
      category: "source-layer",
      evidence: {
        sampledSourceLayers: ["buildings", "poi"],
        sampledTiles: ["0/0/0", "14/14549/6451"]
      }
    });
  });

  it("raises absence findings when the caller says the sample is worth trusting", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("unlabeled-source"),
      sampledAbsenceSeverity: "risky"
    });

    expect(report.findings.map((finding) => [finding.id, finding.severity])).toEqual([
      ["layer.waterways.source-layer-not-sampled", "risky"],
      ["layer.buildings-by-operator.property.operator.not-observed", "risky"]
    ]);
  });

  // Metadata that lists a source-layer's fields and omits this one is real
  // evidence, not an empty sample, so the flag must leave it alone.
  it("does not lower a property that declared metadata positively omits", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(
      report.findings.find(
        (finding) =>
          finding.category === "expression-property" && finding.property === "missing_name"
      )?.severity
    ).toBe("risky");
  });

  it("reports source-layers as unverified when metadata and samples are both missing", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("unlabeled-source"),
      sampleTiles: false
    });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toHaveLength(0);
    expect(report.incompleteChecks.map((check) => check.id)).toEqual([
      "layer.poi-labels.source-layer-unverified",
      "layer.waterways.source-layer-unverified",
      "layer.buildings-by-operator.source-layer-unverified"
    ]);
  });

  it("flags a source whose tiles cannot be read at any sampled address", async () => {
    const report = await checkStyleContract({ stylePath: fixture("empty-tiles") });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "source.basemap.no-sampled-tiles",
        severity: "risky",
        category: "tile-availability",
        evidence: { attempted: ["0/0/0", "7/37/48", "14/14549/6451"] }
      })
    ]);
  });

  it("limits how many addresses each source is probed at", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("empty-tiles"),
      maxSampleTiles: 1
    });

    expect(report.findings[0]?.evidence).toEqual({ attempted: ["0/0/0"] });
  });

  // A sample that read nothing counted as usable because nothing threw, so
  // `tile-sample: passed` appeared beside a `no-sampled-tiles` finding on the
  // very same source.
  it("does not pass the tile-sample check on a sample that read nothing", async () => {
    const report = await checkStyleContract({ stylePath: fixture("empty-tiles") });

    expect(report.findings.some((item) => item.id === "source.basemap.no-sampled-tiles")).toBe(
      true
    );
    expect(report.checks.find((check) => check.id === "tile-sample")?.status).toBe("incomplete");
  });

  it("still passes the tile-sample check when tiles really were read", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("simple-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.checks.find((check) => check.id === "tile-sample")?.status).toBe("passed");
  });
});

describe("offline runs", () => {
  it("reports a remote source as incomplete instead of fetching it", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("remote-source"),
      allowNetwork: false
    });

    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks).toEqual([
      expect.objectContaining({
        id: "source.openmaptiles.network-disabled",
        category: "source"
      })
    ]);
  });

  it("still checks local artifacts", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }],
      allowNetwork: false
    });

    expect(report.status).toBe("failed");
    expect(report.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining(["source-layer", "icon"])
    );
  });
});

// `node:path.dirname` was applied to a style location whether it was a path or
// a URL, and `resolve` then turned every relative reference in a remote style
// into a local filesystem path. The artifacts were never requested at all.
describe("a remote style with relative references", () => {
  const requested: string[] = [];
  let origin = "";

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requested.push(url.pathname);

    if (url.pathname === "/styles/basemap/style.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: 8,
          sprite: "../../sprite",
          glyphs: "../../fonts/{fontstack}/{range}.pbf",
          sources: { basemap: { type: "vector", url: "./tilejson.json" } },
          layers: [
            {
              id: "poi-labels",
              type: "symbol",
              source: "basemap",
              "source-layer": "poi",
              layout: {
                "text-field": ["get", "name"],
                "text-font": ["Noto Sans Regular"],
                "icon-image": "cafe"
              }
            }
          ]
        })
      );
      return;
    }

    if (url.pathname === "/styles/basemap/tilejson.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          tilejson: "3.0.0",
          minzoom: 0,
          maxzoom: 14,
          // Relative to the TileJSON, and its braces must survive resolution.
          tiles: ["./tiles/{z}/{x}/{y}.mvt"],
          vector_layers: [{ id: "poi", fields: { name: "String" }, minzoom: 0, maxzoom: 14 }]
        })
      );
      return;
    }

    if (url.pathname === "/sprite.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cafe: { x: 0, y: 0, width: 1, height: 1, pixelRatio: 1 } }));
      return;
    }

    if (url.pathname === "/fonts/Noto%20Sans%20Regular/0-255.pbf") {
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end(Buffer.from([0x0a, 0x00]));
      return;
    }

    response.writeHead(404).end();
  });

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function checkRemote() {
    requested.length = 0;
    const report = await checkStyleContract({
      stylePath: `${origin}/styles/basemap/style.json`,
      timeoutMs: 5_000
    });
    return report;
  }

  it("requests the source the style's relative URL names", async () => {
    await checkRemote();

    expect(requested).toContain("/styles/basemap/tilejson.json");
  });

  it("resolves relative sprite and glyph references above the style's directory", async () => {
    await checkRemote();

    expect(requested).toContain("/sprite.json");
    expect(requested).toContain("/fonts/Noto%20Sans%20Regular/0-255.pbf");
  });

  it("reads the source contract instead of reporting it unreadable", async () => {
    const report = await checkRemote();

    expect(report.incompleteChecks.map((check) => check.id)).not.toContain(
      "source.basemap.read-failed"
    );
    expect(report.findings.filter((finding) => finding.category === "source-layer")).toEqual([]);
  });

  it("keeps a tile template's placeholders unencoded when resolving it", async () => {
    await checkRemote();

    expect(requested.some((path) => path.includes("%7B"))).toBe(false);
    expect(requested).toContain("/styles/basemap/tiles/0/0/0.mvt");
  });
});
