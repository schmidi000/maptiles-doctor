import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStyleContract } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

function fixture(name: string): string {
  return resolve(root, "fixtures", name, "style.json");
}

describe("sprite checks", () => {
  it("flags an icon that is missing from the sprite index", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    const finding = report.findings.find((item) => item.category === "icon");
    expect(finding).toMatchObject({
      id: "sprite.icon.cafe.missing",
      severity: "broken",
      category: "icon"
    });
    expect(finding?.path).toMatch(/sprite\.json$/);
  });

  // The assets status read the incomplete list only, so it could never say
  // `failed`. A report carried a broken `sprite.icon.cafe.missing` finding next
  // to an `assets` check that said `passed`, which no consumer can act on.
  it("fails the assets check that its own broken finding belongs to", async () => {
    const report = await checkStyleContract({
      stylePath: fixture("broken-style"),
      sources: [{ id: "openmaptiles", location: tilejson }]
    });

    expect(report.findings.some((item) => item.id === "sprite.icon.cafe.missing")).toBe(true);
    expect(report.checks.find((check) => check.id === "assets")?.status).toBe("failed");
  });

  it("reports an unreadable sprite index as incomplete rather than passing it", async () => {
    const report = await checkStyleContract({ stylePath: fixture("missing-sprite") });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toHaveLength(0);
    expect(report.incompleteChecks).toEqual([
      expect.objectContaining({ id: "sprite.index-unreadable", category: "sprite" })
    ]);
    expect(report.checks.find((check) => check.id === "assets")?.status).toBe("incomplete");
  });

  // The array form declares several sprites and namespaces icons as
  // `<sprite-id>:<icon-name>`. Looking the namespaced string up verbatim in the
  // first sprite made every icon of a 324-layer production style read as
  // missing; see validation/FINDINGS.md.
  describe("multiple sprites", () => {
    async function multiSprite() {
      return checkStyleContract({
        stylePath: fixture("multi-sprite"),
        sources: [{ id: "openmaptiles", location: tilejson }]
      });
    }

    it("resolves a namespaced icon against the sprite its prefix names", async () => {
      const report = await multiSprite();

      expect(
        report.findings.filter((item) => item.id.startsWith("sprite.icon.basics:icon-cafe"))
      ).toEqual([]);
      // The second sprite is read too, not just the first.
      expect(
        report.findings.filter((item) => item.id.startsWith("sprite.icon.extra:icon-star"))
      ).toEqual([]);
    });

    it("flags an icon absent from the sprite its prefix names, and suggests a namespaced fix", async () => {
      const report = await multiSprite();

      expect(
        report.findings.find((item) => item.id === "sprite.icon.basics:icon-absent.missing")
      ).toMatchObject({
        severity: "broken",
        category: "icon",
        // Suggested within the named sprite, and re-namespaced so it can be
        // pasted straight back into the style.
        suggestion: "basics:icon-bank"
      });
    });

    it("flags an icon whose prefix names no declared sprite", async () => {
      const report = await multiSprite();

      expect(
        report.findings.find((item) => item.id === "sprite.icon.basic:icon-cafe.unknown-sprite")
      ).toMatchObject({
        severity: "broken",
        category: "icon",
        suggestion: "basics"
      });
    });

    it("reports only the two broken icons", async () => {
      const report = await multiSprite();

      expect(report.findings.filter((item) => item.category === "icon")).toHaveLength(2);
    });
  });

  // An `icon-image` the expression reducer cannot enumerate leaves the layer
  // unchecked. Before, that layer simply vanished from the report: no finding,
  // no incomplete check, and an `assets` check that said everything was fine.
  describe("an icon-image that cannot be reduced to names", () => {
    async function unresolvable() {
      return checkStyleContract({ stylePath: fixture("unresolvable-icon"), sampleTiles: false });
    }

    it("reports the layer as incomplete rather than silently skipping it", async () => {
      const report = await unresolvable();

      expect(
        report.incompleteChecks.find(
          (item) => item.id === "layer.poi-unmodellable.icon-image.unresolved"
        )
      ).toMatchObject({
        category: "icon",
        evidence: { layerId: "poi-unmodellable" }
      });
    });

    it("keeps that layer out of the findings, since nothing was proved about it", async () => {
      const report = await unresolvable();

      expect(report.findings.filter((item) => item.layerId === "poi-unmodellable")).toEqual([]);
    });

    it("still checks the icons it can enumerate on other layers", async () => {
      const report = await unresolvable();

      // `marker` is in the sprite, so it must not be reported.
      expect(report.findings.filter((item) => item.category === "icon")).toEqual([]);
    });

    it("carries the uncertainty into the assets check and the report status", async () => {
      const report = await unresolvable();

      expect(report.checks.find((check) => check.id === "assets")?.status).toBe("incomplete");
      expect(report.status).toBe("incomplete");
    });
  });

  // An `icon-image` built from feature data has no name until a feature supplies
  // one, so the sampled tiles are the only place its names exist. The sampled
  // poi features carry class=cafe and class=bar; the sprite has icon-cafe but
  // not icon-bar.
  describe("data-driven icon names", () => {
    async function dataDriven() {
      return checkStyleContract({ stylePath: fixture("data-driven-icon") });
    }

    it("checks the names a concat expression builds from sampled features", async () => {
      const report = await dataDriven();

      expect(
        report.findings.find(
          (item) => item.id === "layer.poi-concat.icon-from-data.icon-bar.missing"
        )
      ).toMatchObject({
        severity: "risky",
        category: "icon",
        layerId: "poi-concat",
        sourceLayer: "poi",
        suggestion: "icon-cafe",
        evidence: { properties: ["class"], sampledCombinations: 2 }
      });
    });

    it("checks the legacy {token} spelling identically", async () => {
      const report = await dataDriven();

      expect(
        report.findings.find(
          (item) => item.id === "layer.poi-token.icon-from-data.icon-bar.missing"
        )
      ).toMatchObject({ severity: "risky", suggestion: "icon-cafe" });
    });

    it("does not report a name the sampled features do produce", async () => {
      const report = await dataDriven();

      expect(report.findings.filter((item) => item.id.includes("icon-cafe"))).toEqual([]);
      // poi-coerced resolves to cafe and bar, both of which the sprite carries,
      // and its operator name is not an icon.
      expect(report.findings.filter((item) => item.layerId === "poi-coerced")).toEqual([]);
      expect(report.findings.filter((item) => item.id.includes("to-string"))).toEqual([]);
    });

    it("reports an unsampleable template as incomplete rather than as a finding", async () => {
      const report = await dataDriven();

      expect(
        report.incompleteChecks.find(
          (item) => item.id === "layer.poi-unknown-property.icon-from-data.brand"
        )
      ).toMatchObject({ category: "icon", evidence: { properties: ["brand"] } });
      expect(
        report.findings.filter(
          (item) => item.category === "icon" && item.layerId === "poi-unknown-property"
        )
      ).toEqual([]);
    });

    it("keeps an unverifiable icon check out of a passing assets check", async () => {
      const report = await dataDriven();

      expect(report.checks.find((check) => check.id === "assets")?.status).toBe("incomplete");
    });

    it("reports only the two data-driven findings", async () => {
      const report = await dataDriven();

      expect(report.findings.filter((item) => item.category === "icon")).toHaveLength(2);
    });

    // A layer's `filter` decides which features it ever draws. Checking every
    // value in the source-layer against the sprite asked for icons the style
    // cannot request: 20 of 62 names reported against one production style were
    // excluded by the very layer that was said to want them.
    describe("layer filters", () => {
      it("does not report a name the layer filter excludes", async () => {
        const report = await dataDriven();

        expect(report.findings.filter((item) => item.layerId === "poi-filtered")).toEqual([]);
      });

      it("reads a legacy filter's bare property name identically", async () => {
        const report = await dataDriven();

        expect(report.findings.filter((item) => item.layerId === "poi-filtered-legacy")).toEqual(
          []
        );
      });

      it("counts the features a filter rejected as evidence", async () => {
        const report = await dataDriven();

        expect(
          report.incompleteChecks.find((item) => item.id.startsWith("layer.poi-filtered-geometry."))
        ).toMatchObject({ category: "icon", evidence: { rejectedByFilter: 2 } });
      });

      it("reports incomplete rather than guessing at a filter it cannot decide", async () => {
        const report = await dataDriven();

        expect(
          report.incompleteChecks.find(
            (item) => item.id === "layer.poi-filter-unevaluable.icon-from-data.filter-unevaluable"
          )
        ).toMatchObject({ category: "icon" });
        expect(report.findings.filter((item) => item.layerId === "poi-filter-unevaluable")).toEqual(
          []
        );
      });
    });
  });
});

describe("glyph checks", () => {
  it("accepts a local glyph directory and flags only the missing font stack", async () => {
    const report = await checkStyleContract({ stylePath: fixture("glyph-style") });

    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks).toEqual([
      expect.objectContaining({
        id: "glyph.Missing Font Regular.unreachable",
        category: "glyph"
      })
    ]);
    // The present font stack resolves through a directory name containing
    // spaces, so it must not be percent-encoded on a local path.
    expect(report.incompleteChecks[0]?.path).toContain("Missing Font Regular");
  });
});

describe("remote assets", () => {
  let server: Server;
  let origin: string;
  let workDir: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/tiles.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            tilejson: "3.0.0",
            minzoom: 0,
            maxzoom: 14,
            tiles: [`${origin}/{z}/{x}/{y}.mvt`],
            vector_layers: [{ id: "poi", fields: { name: "String" }, minzoom: 0, maxzoom: 14 }]
          })
        );
        return;
      }
      if (url.pathname === "/fonts/Noto%20Sans%20Regular/0-255.pbf") {
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end(Buffer.from([0x0a, 0x00]));
        return;
      }
      response.writeHead(404).end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeStyle(name: string, style: unknown): Promise<string> {
    const stylePath = join(workDir, `${name}.json`);
    await writeFile(stylePath, JSON.stringify(style));
    return stylePath;
  }

  it("passes when a remote TileJSON source and glyph endpoint are reachable", async () => {
    const stylePath = await writeStyle("remote-ok", {
      version: 8,
      glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
      sources: { basemap: { type: "vector", url: `${origin}/tiles.json` } },
      layers: [
        {
          id: "poi-labels",
          type: "symbol",
          source: "basemap",
          "source-layer": "poi",
          layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"] }
        }
      ]
    });

    const report = await checkStyleContract({ stylePath, timeoutMs: 5_000 });

    expect(report.status).toBe("passed");
    expect(report.incompleteChecks).toHaveLength(0);
  });

  it("percent-encodes font stacks for remote glyph URLs", async () => {
    const stylePath = await writeStyle("remote-glyph-404", {
      version: 8,
      glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
      sources: { basemap: { type: "vector", url: `${origin}/tiles.json` } },
      layers: [
        {
          id: "poi-labels",
          type: "symbol",
          source: "basemap",
          "source-layer": "poi",
          layout: { "text-field": ["get", "name"], "text-font": ["Missing Font Regular"] }
        }
      ]
    });

    const report = await checkStyleContract({ stylePath, timeoutMs: 5_000 });

    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks[0]).toMatchObject({
      id: "glyph.Missing Font Regular.unreachable",
      category: "glyph",
      path: `${origin}/fonts/Missing%20Font%20Regular/0-255.pbf`
    });
  });

  it("does not hash remote artifacts", async () => {
    const stylePath = await writeStyle("remote-hash", {
      version: 8,
      sources: { basemap: { type: "vector", url: `${origin}/tiles.json` } },
      layers: [{ id: "poi", type: "circle", source: "basemap", "source-layer": "poi", paint: {} }]
    });

    const report = await checkStyleContract({ stylePath, timeoutMs: 5_000 });

    expect(Object.keys(report.artifactHashes)).toEqual([stylePath]);
  });
});

// Every remote artifact becomes an incomplete check when the network is off,
// and an unreachable one becomes an incomplete check when it is on. Neither may
// come back as a silent pass: a check that could not run has proved nothing.
describe("glyph endpoints that cannot be checked", () => {
  let workDir: string;

  async function styleWithGlyphs(glyphs: string): Promise<string> {
    const stylePath = join(workDir, `${Buffer.from(glyphs).toString("hex").slice(0, 16)}.json`);
    await writeFile(
      stylePath,
      JSON.stringify({
        version: 8,
        glyphs,
        // A symbol layer needs a source to be spec-valid, and an inline one is
        // never fetched, so the glyph endpoint is the only thing under test.
        sources: {
          basemap: {
            type: "vector",
            tiles: ["https://tiles.invalid.test/{z}/{x}/{y}.pbf"],
            minzoom: 0,
            maxzoom: 2
          }
        },
        layers: [
          {
            id: "labels",
            type: "symbol",
            source: "basemap",
            "source-layer": "poi",
            layout: { "text-field": "x", "text-font": ["Noto Sans Regular"] }
          }
        ]
      })
    );
    return stylePath;
  }

  /**
   * Binds and immediately releases a port so connecting to it is refused at
   * once. Depending on a hostname failing to resolve makes the result
   * environmental: a resolver that hijacks NXDOMAIN answers the lookup, and the
   * check then reports "not reachable" instead of "could not be checked".
   */
  async function closedPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((listening) => probe.listen(0, "127.0.0.1", listening));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((closed, failed) =>
      probe.close((error) => (error ? failed(error) : closed()))
    );
    return port;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-glyphs-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports a remote glyph endpoint as incomplete when the network is disabled", async () => {
    const report = await checkStyleContract({
      stylePath: await styleWithGlyphs("https://glyphs.invalid.test/{fontstack}/{range}.pbf"),
      allowNetwork: false
    });

    expect(
      report.incompleteChecks.find((check) => check.id === "glyph.network-disabled")
    ).toMatchObject({ category: "glyph" });
    expect(report.findings.filter((finding) => finding.category === "glyph")).toEqual([]);
    expect(report.status).toBe("incomplete");
  });

  it("reports an unreachable glyph endpoint as incomplete rather than as a finding", async () => {
    const port = await closedPort();
    const report = await checkStyleContract({
      stylePath: await styleWithGlyphs(`http://127.0.0.1:${port}/{fontstack}/{range}.pbf`),
      // The style's source is remote only so the symbol layer is spec-valid.
      // Sampling it would chase three tiles over DNS and make this test's
      // duration depend on the resolver rather than on the glyph endpoint.
      sampleTiles: false,
      timeoutMs: 2_000
    });

    expect(
      report.incompleteChecks.find((check) => check.id === "glyph.Noto Sans Regular.check-failed")
    ).toMatchObject({ category: "glyph" });
    // The endpoint answered nothing, so nothing was proved about the font: an
    // unreachable artifact must never become a finding.
    expect(report.findings.filter((finding) => finding.category === "glyph")).toEqual([]);
  });
});

// The `sprite` key is either a string or an array of `{id, url}` entries. A
// malformed entry must be skipped rather than turned into a request for
// `undefined.json`, which would read as an unreachable sprite.
describe("sprite declarations", () => {
  let workDir: string;

  async function styleWithSprite(sprite: unknown): Promise<string> {
    const stylePath = join(workDir, `sprite-${(spriteCounter += 1)}.json`);
    await writeFile(
      stylePath,
      JSON.stringify({
        version: 8,
        sprite,
        sources: {},
        layers: [{ id: "poi", type: "symbol", layout: { "icon-image": "marker" } }]
      })
    );
    return stylePath;
  }

  let spriteCounter = 0;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-sprite-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it.each([
    ["a number", 7],
    ["an object", { url: "./sprite" }],
    ["an array of entries without urls", [{ id: "a" }, "bare", 3]]
  ])("emits no sprite check for %s", async (_label, sprite) => {
    const report = await checkStyleContract({ stylePath: await styleWithSprite(sprite) });

    expect(report.incompleteChecks.filter((check) => check.category === "sprite")).toEqual([]);
    expect(report.findings.filter((finding) => finding.category === "icon")).toEqual([]);
  });

  it("reads an array entry that declares a url but no id as the unnamed sprite", async () => {
    const report = await checkStyleContract({
      // Absolute, because the style is written to a temp directory rather than
      // alongside the fixture sprite.
      stylePath: await styleWithSprite([{ url: resolve(root, "fixtures/simple-style/sprite") }])
    });

    // `marker` is in that sprite, so a url-only entry has to have been read.
    expect(report.findings.filter((finding) => finding.category === "icon")).toEqual([]);
    expect(report.incompleteChecks.filter((check) => check.category === "sprite")).toEqual([]);
  });
});
