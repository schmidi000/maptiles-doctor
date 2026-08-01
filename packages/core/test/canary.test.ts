import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import { rewriteStyleForBrowser } from "../src/canary.js";
import { checkStyleContract } from "../src/checker.js";
import type { CanarySpec, DoctorReport, SourceContract } from "../src/types.js";

const fixtures = resolve(import.meta.dirname, "../../../fixtures");
const canaryStyle = join(fixtures, "canary-style/style.json");
const mbtilesStyle = join(fixtures, "mbtiles-style/style.json");

function contract(overrides: Partial<SourceContract> & Pick<SourceContract, "id" | "kind">) {
  return { location: "/tmp/source", vectorLayers: [], ...overrides } as SourceContract;
}

describe("rewriteStyleForBrowser", () => {
  const style = {
    version: 8,
    sprite: "./sprite",
    glyphs: "./glyphs/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "vector", url: "pmtiles://./basemap.pmtiles" },
      tiles: { type: "vector", url: "./tilejson.json" },
      legacy: { type: "vector", url: "./legacy.mbtiles" }
    },
    layers: [
      { id: "a", type: "circle", source: "basemap", "source-layer": "poi" },
      { id: "b", type: "circle", source: "tiles", "source-layer": "poi" },
      { id: "c", type: "circle", source: "legacy", "source-layer": "poi" }
    ]
  } as unknown as StyleSpecification;

  const contracts = new Map<string, SourceContract>([
    ["basemap", contract({ id: "basemap", kind: "pmtiles", location: "/data/basemap.pmtiles" })],
    [
      "tiles",
      contract({
        id: "tiles",
        kind: "tilejson",
        location: "/data/meta/tilejson.json",
        tileUrls: ["../tiles/{z}/{x}/{y}.pbf"],
        minzoom: 0,
        maxzoom: 14
      })
    ],
    ["legacy", contract({ id: "legacy", kind: "mbtiles", location: "/data/legacy.mbtiles" })]
  ]);

  const { browserStyle, unrenderableSources } = rewriteStyleForBrowser(style, "/style", contracts);
  const sources = browserStyle.sources as Record<string, Record<string, unknown>>;

  it("serves a PMTiles archive over the harness origin", () => {
    expect(sources.basemap?.url).toBe(
      "pmtiles://http://maptiles-doctor.localhost/data/basemap.pmtiles"
    );
  });

  it("inlines TileJSON tile templates resolved against the TileJSON, not the style", () => {
    expect(sources.tiles?.tiles).toEqual([
      "http://maptiles-doctor.localhost/data/tiles/{z}/{x}/{y}.pbf"
    ]);
    // The template placeholders have to survive verbatim: MapLibre substitutes
    // them, so a percent-encoded brace would be requested literally.
    expect(String(sources.tiles?.tiles).includes("%7B")).toBe(false);
    expect(sources.tiles?.url).toBeUndefined();
    expect(sources.tiles?.maxzoom).toBe(14);
  });

  // Raster tiles are images over HTTP. Before inline `tiles[]` sources got a
  // contract at all they fell through to the no-contract path and rendered;
  // giving them a `raster` kind must not turn them into unrenderable ones.
  it("renders a raster source instead of dropping it", () => {
    const rasterStyle = {
      version: 8,
      sources: { hillshade: { type: "raster", tiles: ["./shade/{z}/{x}/{y}.png"], tileSize: 256 } },
      layers: [{ id: "shade", type: "raster", source: "hillshade" }]
    } as unknown as StyleSpecification;

    const result = rewriteStyleForBrowser(
      rasterStyle,
      "/style",
      new Map([
        [
          "hillshade",
          contract({
            id: "hillshade",
            kind: "raster",
            location: "/style/style.json",
            tileUrls: ["./shade/{z}/{x}/{y}.png"]
          })
        ]
      ])
    );

    expect(result.unrenderableSources).toEqual([]);
    expect(
      (result.browserStyle.sources as Record<string, Record<string, unknown>>).hillshade?.tiles
    ).toEqual(["http://maptiles-doctor.localhost/style/shade/{z}/{x}/{y}.png"]);
    expect(result.browserStyle.layers.map((layer) => layer.id)).toEqual(["shade"]);
  });

  it("drops sources a browser cannot read, and the layers that use them", () => {
    expect(sources.legacy).toBeUndefined();
    expect(unrenderableSources).toEqual([
      { id: "legacy", reason: "a browser cannot read mbtiles sources" }
    ]);
    expect(browserStyle.layers.map((layer) => layer.id)).toEqual(["a", "b"]);
  });

  it("resolves sprite and glyph templates against the style directory", () => {
    expect(browserStyle.sprite).toBe("http://maptiles-doctor.localhost/style/sprite");
    expect(browserStyle.glyphs).toBe(
      "http://maptiles-doctor.localhost/style/glyphs/{fontstack}/{range}.pbf"
    );
  });

  it("leaves remote locations alone so a canary exercises the real endpoint", () => {
    const remote = rewriteStyleForBrowser(
      {
        version: 8,
        sources: { remote: { type: "vector", url: "https://tiles.example/tilejson.json" } },
        layers: []
      } as unknown as StyleSpecification,
      "/style",
      new Map()
    );
    const rewritten = remote.browserStyle.sources as Record<string, Record<string, unknown>>;
    expect(rewritten.remote?.url).toBe("https://tiles.example/tilejson.json");
  });

  it("reports a source with no inspectable location instead of rendering an empty map", () => {
    const opaque = rewriteStyleForBrowser(
      {
        version: 8,
        sources: { opaque: { type: "vector" } },
        layers: [{ id: "a", type: "circle", source: "opaque" }]
      } as unknown as StyleSpecification,
      "/style",
      new Map()
    );
    expect(opaque.unrenderableSources).toEqual([
      { id: "opaque", reason: "the source has no inspectable location" }
    ]);
    expect(opaque.browserStyle.layers).toEqual([]);
  });
});

/**
 * Rendering needs the optional playwright peer and a downloaded browser. The
 * suite is skipped rather than failed where neither exists, because a missing
 * browser says nothing about the code under test; CI installs Chromium so the
 * canaries always run there.
 */
const browserAvailable = await hasChromium();

describe.skipIf(!browserAvailable)("visual canaries", () => {
  let screenshotDir: string;

  beforeAll(async () => {
    screenshotDir = await mkdtemp(join(tmpdir(), "maptiles-canary-"));
  });

  async function check(
    canaries: CanarySpec[],
    extra: Partial<Parameters<typeof checkStyleContract>[0]> = {}
  ) {
    return checkStyleContract({
      stylePath: canaryStyle,
      canaries,
      screenshotDir,
      timeoutMs: 60_000,
      ...extra
    });
  }

  it("renders the configured view and counts the features it drew", async () => {
    const report = await check([
      { id: "origin", center: [0, 0], zoom: 0, width: 256, height: 256, expectLayers: ["poi-dots"] }
    ]);

    expect(canaryFindings(report)).toEqual([]);
    expect(checkStatus(report, "visual-canary")).toBe("passed");
    expect(existsSync(join(screenshotDir, "origin.png"))).toBe(true);
  }, 120_000);

  it("reports a tile that answers with an error status as broken", async () => {
    // The fixture tile directory only carries zoom 0, 7, and 14, so a canary at
    // zoom 5 asks for tiles that are genuinely not published.
    const report = await check([{ id: "gap", center: [0, 0], zoom: 5, width: 256, height: 256 }]);

    const broken = canaryFindings(report).filter((finding) => finding.severity === "broken");
    expect(broken.length).toBeGreaterThan(0);
    expect(broken[0]?.message).toContain("HTTP 404");
    expect(checkStatus(report, "visual-canary")).toBe("failed");
  }, 120_000);

  it("reports a missing baseline as info and a matching baseline as no finding", async () => {
    const canary: CanarySpec = {
      id: "baseline",
      center: [0, 0],
      zoom: 0,
      width: 256,
      height: 256
    };

    const baselineDir = await mkdtemp(join(tmpdir(), "maptiles-baseline-"));
    const first = await check([canary], { baselineDir });
    expect(canaryFindings(first).map((finding) => finding.id)).toEqual([
      "canary.baseline.baseline-missing"
    ]);

    // The first run's screenshot becomes the baseline, so a deterministic
    // renderer has to reproduce it pixel for pixel.
    await copyFile(join(screenshotDir, "baseline.png"), join(baselineDir, "baseline.png"));
    const second = await check([canary], { baselineDir });
    expect(canaryFindings(second)).toEqual([]);
    expect(second.findings).toEqual([]);
  }, 180_000);

  it("reports a render that no longer matches its baseline", async () => {
    const baselineDir = await mkdtemp(join(tmpdir(), "maptiles-baseline-"));
    const solid = new PNG({ width: 256, height: 256 });
    solid.data.fill(0);
    await writeFile(join(baselineDir, "drift.png"), PNG.sync.write(solid));

    const report = await check(
      [{ id: "drift", center: [0, 0], zoom: 0, width: 256, height: 256 }],
      {
        baselineDir
      }
    );

    const diff = canaryFindings(report).find(
      (finding) => finding.id === "canary.drift.baseline-diff"
    );
    expect(diff?.severity).toBe("risky");
    expect(Number(diff?.evidence?.diffRatio)).toBeGreaterThan(0.005);
    expect(existsSync(join(screenshotDir, "drift.diff.png"))).toBe(true);
  }, 120_000);

  it("reports a source the browser cannot read instead of rendering without it", async () => {
    const report = await checkStyleContract({
      stylePath: mbtilesStyle,
      canaries: [{ id: "mbtiles", center: [0, 0], zoom: 0, width: 256, height: 256 }],
      sampleTiles: false,
      timeoutMs: 60_000
    });

    expect(
      report.incompleteChecks.map((check) => check.id).filter((id) => id.startsWith("canary."))
    ).toContain("canary.source.basemap.unrenderable");
    expect(checkStatus(report, "visual-canary")).toBe("incomplete");
  }, 120_000);

  it("blocks remote artifacts offline and reports the canary as incomplete", async () => {
    const styleDir = await mkdtemp(join(tmpdir(), "maptiles-offline-"));
    const style = JSON.parse(await readFile(canaryStyle, "utf8")) as Record<string, unknown>;
    (style.sources as Record<string, Record<string, unknown>>).openmaptiles = {
      type: "vector",
      tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"],
      maxzoom: 14
    };
    const offlineStyle = join(styleDir, "style.json");
    await writeFile(offlineStyle, JSON.stringify(style));

    const report = await checkStyleContract({
      stylePath: offlineStyle,
      canaries: [{ id: "offline", center: [0, 0], zoom: 0, width: 256, height: 256 }],
      allowNetwork: false,
      timeoutMs: 60_000
    });

    const unfinished = report.incompleteChecks.find(
      (check) => check.id === "canary.offline.requests-unfinished"
    );
    expect(unfinished?.category).toBe("visual-canary");
    expect(checkStatus(report, "visual-canary")).toBe("incomplete");
  }, 120_000);
});

function canaryFindings(report: DoctorReport) {
  return report.findings.filter((finding) => finding.category === "visual-canary");
}

function checkStatus(report: DoctorReport, id: string) {
  return report.checks.find((check) => check.id === id)?.status;
}

async function hasChromium(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    // Launching is the only reliable probe: the headless shell and the full
    // browser live at different paths, and either one is enough to render.
    const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
