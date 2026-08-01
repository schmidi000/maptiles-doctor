import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Browser, Route } from "playwright";
import { isHttpUrl, locationDir, resolveLocation } from "./io.js";
import type { CanaryObservation, CanaryRun, CanarySpec, SourceContract } from "./types.js";

/**
 * Every local artifact is served to the browser from this origin, with the
 * absolute filesystem path as the URL path. MapLibre resolves a relative
 * source, sprite, or glyph URL against the document rather than against the
 * file that declared it, so a canary rewrites the style to absolute URLs before
 * handing it to the map instead of relying on the browser to get it right.
 */
const ORIGIN = "http://maptiles-doctor.localhost";
const HARNESS_PREFIX = "/__maptiles-doctor/";
const HARNESS_URL = `${ORIGIN}${HARNESS_PREFIX}harness.html`;
const MAPLIBRE_PREFIX = `${HARNESS_PREFIX}maplibre/`;
const PMTILES_PATH = `${HARNESS_PREFIX}pmtiles.js`;

const DEFAULT_SIZE = 512;
const DEFAULT_MAX_DIFF_RATIO = 0.005;

export interface VisualCanaryOptions {
  style: StyleSpecification;
  styleDir: string;
  contracts: Map<string, SourceContract>;
  canaries: CanarySpec[];
  screenshotDir?: string | undefined;
  baselineDir?: string | undefined;
  maxDiffRatio?: number | undefined;
  timeoutMs: number;
  allowNetwork: boolean;
}

/**
 * Renders each configured canary with MapLibre GL in headless Chromium and
 * reports what the map actually drew. Playwright and maplibre-gl are optional
 * peers: when either is missing the whole run degrades to unavailable rather
 * than failing the check, because a machine without a browser has proved
 * nothing about the style.
 */
export async function runVisualCanaries(options: VisualCanaryOptions): Promise<CanaryRun> {
  for (const canary of options.canaries) {
    assertSafeCanaryId(canary.id);
  }

  const { browserStyle, unrenderableSources, droppedLayers } = rewriteStyleForBrowser(
    options.style,
    options.styleDir,
    options.contracts
  );

  let assets: HarnessAssets;
  let chromium: typeof import("playwright").chromium;
  try {
    assets = resolveHarnessAssets();
    ({ chromium } = await import("playwright"));
  } catch (error) {
    return {
      observations: [],
      unrenderableSources,
      droppedLayers,
      unavailable: `Visual canaries need the optional playwright and maplibre-gl packages: ${messageOf(error)}`
    };
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({
      // Headless Chromium has no GPU; SwiftShader is what makes WebGL, and so
      // MapLibre, work on a CI runner.
      args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"]
    });
  } catch (error) {
    return {
      observations: [],
      unrenderableSources,
      droppedLayers,
      unavailable: `Could not launch Chromium for visual canaries: ${messageOf(error)}`
    };
  }

  try {
    const observations: CanaryObservation[] = [];
    for (const canary of options.canaries) {
      observations.push(await renderCanary(browser, assets, browserStyle, canary, options));
    }
    return { observations, unrenderableSources, droppedLayers };
  } finally {
    await browser.close();
  }
}

/**
 * A canary id becomes a file name in the screenshot and baseline directories, so
 * it has to stay one path segment. An id of `../escaped` resolved to a sibling
 * of the configured directory and `writeFile` overwrote whatever was there —
 * and the baseline read walked out of the directory the same way. Rejecting the
 * id outright is clearer than silently rewriting a name the report then cites.
 */
const safeCanaryId = /^[A-Za-z0-9._-]+$/;

function assertSafeCanaryId(id: string): void {
  if (!safeCanaryId.test(id) || id === "." || id === "..") {
    throw new Error(
      `Canary id ${JSON.stringify(id)} is not a valid file name. Use letters, digits, dot, underscore, or hyphen.`
    );
  }
}

async function renderCanary(
  browser: Browser,
  assets: HarnessAssets,
  browserStyle: StyleSpecification,
  canary: CanarySpec,
  options: VisualCanaryOptions
): Promise<CanaryObservation> {
  const width = canary.width ?? DEFAULT_SIZE;
  const height = canary.height ?? DEFAULT_SIZE;
  const observation: CanaryObservation = {
    id: canary.id,
    featureCount: 0,
    featuresByLayer: {},
    mapErrors: [],
    httpErrors: [],
    transportErrors: []
  };

  const page = await browser.newPage({
    viewport: { width, height },
    // A fractional device pixel ratio would make every screenshot depend on the
    // host display, which defeats baseline comparison.
    deviceScaleFactor: 1
  });

  try {
    page.on("requestfailed", (request) => {
      observation.transportErrors.push(
        `${request.url()}: ${request.failure()?.errorText ?? "request failed"}`
      );
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        observation.httpErrors.push(`${response.url()}: HTTP ${response.status()}`);
      }
    });

    await page.route("**/*", (route) => serveRoute(route, assets, width, height, options));
    await page.goto(HARNESS_URL, { timeout: options.timeoutMs });
    await page.waitForFunction(() => window.__maptilesDoctorReady === true, null, {
      timeout: options.timeoutMs
    });

    // The style is passed as `unknown`: inferring playwright's evaluate
    // generics over the full style specification type exhausts the checker.
    const payload: CanaryPayload = {
      style: browserStyle,
      view: {
        center: canary.center,
        zoom: canary.zoom,
        bearing: canary.bearing ?? 0,
        pitch: canary.pitch ?? 0
      }
    };
    await page.evaluate(
      (input: CanaryPayload) => window.__maptilesDoctorRender(input.style, input.view),
      payload
    );

    try {
      await page.waitForFunction(() => window.__maptilesDoctorIdle === true, null, {
        timeout: options.timeoutMs
      });
    } catch {
      // A map that never goes idle has not proved anything, but the errors it
      // collected on the way are still worth reporting.
      observation.incomplete = `Canary ${canary.id} did not finish rendering within ${options.timeoutMs}ms.`;
    }

    const rendered = await page.evaluate(() => window.__maptilesDoctorCollect());
    observation.featureCount = rendered.featureCount;
    observation.featuresByLayer = rendered.featuresByLayer;
    observation.mapErrors = rendered.errors;
    const expectedButEmpty = (canary.expectLayers ?? []).filter(
      (layerId) => (rendered.featuresByLayer[layerId] ?? 0) === 0
    );
    if (expectedButEmpty.length > 0) {
      observation.expectedButEmpty = expectedButEmpty;
    }

    const screenshot = await page.locator("#map").screenshot({ timeout: options.timeoutMs });
    await recordScreenshot(observation, screenshot, canary, options);
  } catch (error) {
    observation.incomplete = `Canary ${canary.id} could not be rendered: ${messageOf(error)}`;
  } finally {
    await page.close();
  }

  return observation;
}

async function recordScreenshot(
  observation: CanaryObservation,
  screenshot: Buffer,
  canary: CanarySpec,
  options: VisualCanaryOptions
): Promise<void> {
  // The baseline is read before the screenshot is written, so pointing both
  // directories at the same place compares against the previous run and then
  // updates it, instead of comparing a render against itself.
  const comparison = options.baselineDir
    ? await compareToBaseline(observation, screenshot, canary, options.baselineDir)
    : undefined;

  if (options.screenshotDir) {
    const target = join(resolveLocation(options.screenshotDir), `${canary.id}.png`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, screenshot);
    observation.screenshotPath = target;

    if (comparison && comparison.diffPixels > 0) {
      const diffPath = join(resolveLocation(options.screenshotDir), `${canary.id}.diff.png`);
      await writeFile(diffPath, PNG.sync.write(comparison.diff));
      observation.diffPath = diffPath;
    }
  }
}

async function compareToBaseline(
  observation: CanaryObservation,
  screenshot: Buffer,
  canary: CanarySpec,
  baselineDir: string
): Promise<{ diff: PNG; diffPixels: number } | undefined> {
  const baselinePath = join(resolveLocation(baselineDir), `${canary.id}.png`);
  observation.baselinePath = baselinePath;

  let baseline: Buffer;
  try {
    baseline = await readFile(baselinePath);
  } catch {
    observation.baselineMissing = true;
    return undefined;
  }

  const current = PNG.sync.read(screenshot);
  const expected = PNG.sync.read(baseline);
  if (current.width !== expected.width || current.height !== expected.height) {
    observation.incomplete = `Baseline for canary ${canary.id} is ${expected.width}x${expected.height} but the canary rendered ${current.width}x${current.height}.`;
    return undefined;
  }

  const diff = new PNG({ width: current.width, height: current.height });
  const diffPixels = pixelmatch(
    current.data,
    expected.data,
    diff.data,
    current.width,
    current.height,
    { threshold: 0.1 }
  );
  observation.diffPixels = diffPixels;
  observation.diffRatio = diffPixels / (current.width * current.height);
  return { diff, diffPixels };
}

export function canaryDiffThreshold(maxDiffRatio: number | undefined): number {
  return maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO;
}

/**
 * Turns the style into one a browser can load from this process: every source
 * becomes an inline definition built from the contract already read in Node,
 * and every local path becomes an absolute URL on the harness origin. Sources
 * the browser cannot read at all — MBTiles, or anything without an inspectable
 * location — are dropped along with the layers that use them, so the rest of
 * the map still renders and the gap is reported instead of drawn as an empty
 * canvas.
 */
export function rewriteStyleForBrowser(
  style: StyleSpecification,
  styleDir: string,
  contracts: Map<string, SourceContract>
): {
  browserStyle: StyleSpecification;
  unrenderableSources: Array<{ id: string; reason: string }>;
  droppedLayers: string[];
} {
  const unrenderableSources: Array<{ id: string; reason: string }> = [];
  const sources: Record<string, unknown> = {};

  for (const [sourceId, source] of Object.entries(style.sources ?? {})) {
    const record = { ...(source as Record<string, unknown>) };
    const contract = contracts.get(sourceId);

    if (!contract) {
      if (typeof record.url === "string" || Array.isArray(record.tiles)) {
        sources[sourceId] = absolutizeSource(record, styleDir);
        continue;
      }
      unrenderableSources.push({
        id: sourceId,
        reason: "the source has no inspectable location"
      });
      continue;
    }

    if (contract.kind === "pmtiles") {
      sources[sourceId] = {
        ...record,
        url: `pmtiles://${toBrowserUrl(stripPmtilesProtocol(contract.location), styleDir)}`
      };
      continue;
    }

    // Raster tiles are ordinary images over HTTP, so a browser reads them as
    // happily as vector ones. Both kinds are a list of templates plus a zoom
    // range, and the source `type` carried over from the style tells MapLibre
    // which it is.
    if (contract.kind === "tilejson" || contract.kind === "raster") {
      const tileUrls = (contract.tileUrls ?? []).map((template) =>
        toBrowserUrl(template, locationDir(contract.location))
      );
      if (tileUrls.length === 0) {
        unrenderableSources.push({
          id: sourceId,
          reason: "the source declares no tile URL template"
        });
        continue;
      }
      // The TileJSON itself is not served: the browser would resolve its
      // relative tile templates against the document, so the templates are
      // inlined already absolute.
      delete record.url;
      sources[sourceId] = {
        ...record,
        tiles: tileUrls,
        ...(contract.minzoom === undefined ? {} : { minzoom: contract.minzoom }),
        ...(contract.maxzoom === undefined ? {} : { maxzoom: contract.maxzoom }),
        ...(contract.bounds === undefined ? {} : { bounds: contract.bounds })
      };
      continue;
    }

    unrenderableSources.push({
      id: sourceId,
      reason: `a browser cannot read ${contract.kind} sources`
    });
  }

  const droppedSources = new Set(unrenderableSources.map((entry) => entry.id));
  const droppedLayers: string[] = [];
  const layers = (Array.isArray(style.layers) ? style.layers : []).filter((layer) => {
    const record = layer as Record<string, unknown>;
    if (typeof record.source === "string" && droppedSources.has(record.source)) {
      // Recorded, not just discarded: the report has to be able to tell a layer
      // that drew nothing from one that was never given the chance.
      droppedLayers.push(typeof record.id === "string" ? record.id : "unknown-layer");
      return false;
    }
    return true;
  });

  const browserStyle = {
    ...style,
    sources,
    layers,
    ...(style.sprite === undefined ? {} : { sprite: absolutizeSprite(style.sprite, styleDir) }),
    ...(style.glyphs === undefined ? {} : { glyphs: toBrowserUrl(style.glyphs, styleDir) })
  } as StyleSpecification;

  return { browserStyle, unrenderableSources, droppedLayers };
}

function absolutizeSource(
  record: Record<string, unknown>,
  styleDir: string
): Record<string, unknown> {
  const next = { ...record };
  if (typeof next.url === "string") {
    next.url = toBrowserUrl(next.url, styleDir);
  }
  if (Array.isArray(next.tiles)) {
    next.tiles = next.tiles.map((tile) =>
      typeof tile === "string" ? toBrowserUrl(tile, styleDir) : tile
    );
  }
  return next;
}

function absolutizeSprite(sprite: StyleSpecification["sprite"], styleDir: string): unknown {
  if (typeof sprite === "string") {
    return toBrowserUrl(sprite, styleDir);
  }
  if (Array.isArray(sprite)) {
    return sprite.map((entry) =>
      entry && typeof entry === "object" && typeof entry.url === "string"
        ? { ...entry, url: toBrowserUrl(entry.url, styleDir) }
        : entry
    );
  }
  return sprite;
}

/**
 * A URL template keeps its `{z}/{x}/{y}` placeholders verbatim: MapLibre
 * substitutes them before the request is made, and percent-encoding the braces
 * here would leave the browser asking for a literal `%7Bz%7D` tile.
 */
function toBrowserUrl(location: string, baseDir: string): string {
  // Resolved first: a relative reference inside a remote style resolves to a URL
  // the browser fetches directly, and only a real local path needs the harness
  // origin in front of it.
  const resolved = resolveLocation(location, baseDir);
  return isHttpUrl(resolved) ? resolved : `${ORIGIN}${resolved}`;
}

function stripPmtilesProtocol(location: string): string {
  return location.startsWith("pmtiles://") ? location.slice("pmtiles://".length) : location;
}

interface HarnessAssets {
  maplibreDir: string;
  pmtilesScript: string;
}

/**
 * Both packages are resolved through their `package.json` rather than through a
 * deep path, because a package that does not export its `dist` directory would
 * otherwise be unreachable even though the files are on disk.
 */
function resolveHarnessAssets(): HarnessAssets {
  const require = createRequire(import.meta.url);
  return {
    maplibreDir: join(dirname(require.resolve("maplibre-gl/package.json")), "dist"),
    pmtilesScript: join(dirname(require.resolve("pmtiles/package.json")), "dist/pmtiles.js")
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".pbf": "application/x-protobuf",
  ".png": "image/png",
  ".webp": "image/webp"
};

async function serveRoute(
  route: Route,
  assets: HarnessAssets,
  width: number,
  height: number,
  options: VisualCanaryOptions
): Promise<void> {
  const url = new URL(route.request().url());

  if (url.origin !== ORIGIN) {
    if (options.allowNetwork) {
      await route.continue();
      return;
    }
    // Aborting shows up as a transport error, which is reported as incomplete:
    // an offline run has not disproved a remote artifact.
    await route.abort("blockedbyclient");
    return;
  }

  const path = decodeURIComponent(url.pathname);
  if (path === `${HARNESS_PREFIX}harness.html`) {
    await route.fulfill({ contentType: "text/html", body: harnessHtml(width, height) });
    return;
  }

  const filePath = path.startsWith(MAPLIBRE_PREFIX)
    ? join(assets.maplibreDir, path.slice(MAPLIBRE_PREFIX.length))
    : path === PMTILES_PATH
      ? assets.pmtilesScript
      : path;

  await fulfillFromDisk(route, filePath);
}

async function fulfillFromDisk(route: Route, filePath: string): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(resolve(filePath));
  } catch (error) {
    await route.fulfill({ status: 404, contentType: "text/plain", body: messageOf(error) });
    return;
  }

  // Tiles are commonly stored gzipped on disk, and MapLibre hands whatever it
  // receives straight to its vector tile parser. Decompressing here is more
  // reliable than asking the browser to, because a fulfilled route does not
  // always honour a `content-encoding` header.
  if (body.length > 1 && body[0] === 0x1f && body[1] === 0x8b) {
    body = gunzipSync(body);
  }

  const extension = extname(filePath).toLowerCase();
  const headers: Record<string, string> = { "accept-ranges": "bytes" };

  // PMTiles reads its header, directory, and tiles with range requests.
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    await route.fulfill({
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1)
    });
    return;
  }

  await route.fulfill({
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    headers,
    body
  });
}

function harnessHtml(width: number, height: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${MAPLIBRE_PREFIX}maplibre-gl.css">
<style>html,body{margin:0;padding:0;background:#fff}#map{width:${width}px;height:${height}px}</style>
<div id="map"></div>
<script src="${PMTILES_PATH}"></script>
<script type="module">
import * as maplibregl from "${MAPLIBRE_PREFIX}maplibre-gl.mjs";

maplibregl.addProtocol("pmtiles", new window.pmtiles.Protocol().tile);

window.__maptilesDoctorRender = (style, view) => {
  window.__maptilesDoctorIdle = false;
  window.__maptilesDoctorErrors = [];
  window.__maptilesDoctorMap?.remove();
  const map = new maplibregl.Map({
    container: "map",
    style,
    center: view.center,
    zoom: view.zoom,
    bearing: view.bearing,
    pitch: view.pitch,
    attributionControl: false,
    interactive: false,
    // A fade would make the screenshot depend on when idle happened to fire.
    fadeDuration: 0
  });
  map.on("error", (event) => {
    window.__maptilesDoctorErrors.push(String(event.error?.message ?? event.error ?? event));
  });
  map.once("idle", () => {
    window.__maptilesDoctorIdle = true;
  });
  window.__maptilesDoctorMap = map;
};

window.__maptilesDoctorCollect = () => {
  const featuresByLayer = {};
  const features = window.__maptilesDoctorMap.queryRenderedFeatures();
  for (const feature of features) {
    featuresByLayer[feature.layer.id] = (featuresByLayer[feature.layer.id] ?? 0) + 1;
  }
  return {
    featureCount: features.length,
    featuresByLayer,
    errors: [...new Set(window.__maptilesDoctorErrors)]
  };
};

window.__maptilesDoctorReady = true;
</script>
`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CanaryPayload {
  style: unknown;
  view: { center: [number, number]; zoom: number; bearing: number; pitch: number };
}

declare global {
  interface Window {
    __maptilesDoctorReady?: boolean;
    __maptilesDoctorIdle?: boolean;
    __maptilesDoctorRender: (style: unknown, view: CanaryPayload["view"]) => void;
    __maptilesDoctorCollect: () => {
      featureCount: number;
      featuresByLayer: Record<string, number>;
      errors: string[];
    };
  }
}
