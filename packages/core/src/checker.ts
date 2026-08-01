import { dirname, resolve } from "node:path";
import {
  validateStyleMin,
  type LayerSpecification,
  type StyleSpecification
} from "@maplibre/maplibre-gl-style-spec";
import { canaryDiffThreshold, runVisualCanaries } from "./canary.js";
import {
  collectStyleUsage,
  iconTemplateProperties,
  renderIconName,
  type IconNameTemplate,
  type StyleUsage
} from "./expression.js";
import { parseDoctorReport } from "./report-schema.js";
import { hashLocalFile, headOrGetOk, isHttpUrl, readJson, resolveLocation } from "./io.js";
import { inlineSourceContract, readSourceContract } from "./source-reader.js";
import { sampleSourceTiles } from "./tile-sampler.js";
import {
  type CanaryObservation,
  type CanaryRun,
  type DoctorCheckOptions,
  type DoctorReport,
  type Finding,
  type Severity,
  type SourceContract,
  type TileSample,
  severityRank
} from "./types.js";

export async function checkStyleContract(options: DoctorCheckOptions): Promise<DoctorReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const failThreshold = options.failThreshold ?? "broken";
  const allowNetwork = options.allowNetwork ?? true;
  const sampleTiles = options.sampleTiles ?? true;
  // Absence from a partial sample is weak evidence: three tiles will not contain
  // a rare feature even in a healthy tileset. Default it to info and let a
  // project that knows its tiles are dense raise it.
  const absenceSeverity: Severity = options.sampledAbsenceSeverity ?? "info";
  const stylePath = resolveLocation(options.stylePath);
  const styleDir = dirname(stylePath);
  const style =
    options.styleText === undefined
      ? await readJson<StyleSpecification>(stylePath, timeoutMs)
      : parseStyleText(options.styleText);
  const findings: Finding[] = [];
  const incompleteChecks: DoctorReport["incompleteChecks"] = [];
  const checks: DoctorReport["checks"] = [];
  const artifactHashes: DoctorReport["artifactHashes"] = {};

  // An in-memory style has no hash worth reporting: the file on disk is not
  // what was checked, so hashing it would attribute the report to the wrong
  // artifact.
  const styleHash = options.styleText === undefined ? await hashLocalFile(stylePath) : undefined;
  if (styleHash) {
    artifactHashes[stylePath] = styleHash;
  }

  const styleErrors = validateStyleMin(style);
  for (const error of styleErrors) {
    findings.push({
      id: "style-spec.invalid",
      severity: "broken",
      category: "style-spec",
      message: String(error.message ?? error),
      path: String("key" in error ? error.key : "style")
    });
  }
  checks.push({
    id: "style-spec",
    status: styleErrors.length === 0 ? "passed" : "failed",
    message:
      styleErrors.length === 0
        ? "Style specification is valid."
        : "Style specification errors found."
  });

  const explicitSources = new Map(
    (options.sources ?? []).map((source) => [source.id, source.location])
  );
  const styleSources = style.sources ?? {};
  const contracts = new Map<string, Awaited<ReturnType<typeof readSourceContract>>>();

  for (const [sourceId, source] of Object.entries(styleSources)) {
    const explicitLocation = explicitSources.get(sourceId);

    // An explicit --source override still wins: it points at a real archive or
    // TileJSON, which carries more than the style ever declares.
    if (!explicitLocation && declaresTilesInline(source)) {
      contracts.set(sourceId, inlineSourceContract(sourceId, source, stylePath));
      continue;
    }

    const styleLocation = sourceLocationFromStyleSource(source);
    if (!explicitLocation && !styleLocation) {
      incompleteChecks.push({
        id: `source.${sourceId}.metadata-missing`,
        category: "source",
        sourceId,
        message: `Source ${sourceId} has no inspectable location. Pass --source ${sourceId}=<pmtiles|mbtiles|tilejson>.`
      });
      continue;
    }

    const resolved = explicitLocation
      ? resolveLocation(stripPmtilesProtocol(explicitLocation))
      : resolveLocation(stripPmtilesProtocol(styleLocation!), styleDir);
    if (!allowNetwork && isHttpUrl(resolved)) {
      incompleteChecks.push({
        id: `source.${sourceId}.network-disabled`,
        category: "source",
        sourceId,
        path: resolved,
        message: `Source ${sourceId} is remote and network access is disabled.`
      });
      continue;
    }
    try {
      const contract = await readSourceContract(sourceId, resolved, timeoutMs);
      contracts.set(sourceId, contract);
      const hash = await hashLocalFile(resolved);
      if (hash) {
        artifactHashes[resolved] = hash;
      }
    } catch (error) {
      incompleteChecks.push({
        id: `source.${sourceId}.read-failed`,
        category: "source",
        sourceId,
        path: resolved,
        message: `Could not read source ${sourceId}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  for (const source of options.sources ?? []) {
    if (contracts.has(source.id) || styleSources[source.id]) {
      continue;
    }
    findings.push({
      id: `source.${source.id}.unused`,
      severity: "warning",
      category: "source",
      sourceId: source.id,
      path: source.location,
      message: `Source override ${source.id} was provided but the style does not define that source.`
    });
  }

  // Collected before sampling: a data-driven `icon-image` names the properties
  // whose values have to be read out of the tiles to know what it produces.
  const usage = collectStyleUsage(style);
  const valueProperties = iconTemplateProperties(usage.iconTemplates);

  const samples = new Map<string, TileSample>();
  if (sampleTiles) {
    for (const [sourceId, contract] of contracts) {
      const sample = await sampleSourceTiles(contract, {
        timeoutMs,
        allowNetwork,
        valueProperties,
        ...(options.sampleAt === undefined ? {} : { sampleAt: options.sampleAt }),
        ...(options.maxSampleTiles === undefined ? {} : { maxTiles: options.maxSampleTiles })
      });
      samples.set(sourceId, sample);
      reportSampleHealth(sourceId, sample, findings, incompleteChecks);
    }
  }
  checks.push({
    id: "tile-sample",
    status: tileSampleStatus(sampleTiles, contracts, samples),
    message: sampleTiles
      ? "Sampled vector tiles for observed layers and properties."
      : "Tile sampling was disabled; checks used declared metadata only."
  });

  const layers = Array.isArray(style.layers) ? style.layers : [];
  for (const layer of layers) {
    inspectLayer(layer, style, contracts, samples, findings, incompleteChecks, absenceSeverity);
  }

  checks.push({
    id: "source-layer",
    status: findings.some(
      (finding) => finding.category === "source-layer" && finding.severity === "broken"
    )
      ? "failed"
      : incompleteChecks.some((check) => check.category === "source-layer")
        ? "incomplete"
        : "passed",
    message: "Checked style layers against declared and sampled vector layers."
  });

  await inspectSprite(
    style,
    usage,
    layers,
    samples,
    styleDir,
    timeoutMs,
    allowNetwork,
    findings,
    incompleteChecks
  );
  await inspectGlyphs(style, usage.fontStacks, styleDir, timeoutMs, allowNetwork, incompleteChecks);
  inspectExpressionProperties(
    layers,
    contracts,
    samples,
    usage.properties,
    findings,
    absenceSeverity
  );

  checks.push({
    id: "assets",
    status: incompleteChecks.some(
      (check) =>
        check.category === "glyph" || check.category === "sprite" || check.category === "icon"
    )
      ? "incomplete"
      : "passed",
    message: "Checked glyph and sprite references."
  });

  // Canaries are opt-in, so a run without them gets no check entry at all: a
  // check that never ran must not appear as one that passed.
  if (options.canaries?.length) {
    const run = await runVisualCanaries({
      style,
      styleDir,
      contracts,
      canaries: options.canaries,
      screenshotDir: options.screenshotDir,
      baselineDir: options.baselineDir,
      maxDiffRatio: options.maxDiffRatio,
      timeoutMs: timeoutMs,
      allowNetwork
    });
    reportCanaryRun(run, canaryDiffThreshold(options.maxDiffRatio), findings, incompleteChecks);
    checks.push({
      id: "visual-canary",
      status: canaryStatus(run, findings),
      message: `Rendered ${run.observations.length} of ${options.canaries.length} visual canaries.`
    });
  }

  const summary = {
    broken: findings.filter((finding) => finding.severity === "broken").length,
    risky: findings.filter((finding) => finding.severity === "risky").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    incomplete: incompleteChecks.length
  };

  const hasFailingFinding = findings.some(
    (finding) => severityRank[finding.severity] >= severityRank[failThreshold]
  );
  const status = hasFailingFinding
    ? "failed"
    : incompleteChecks.length > 0
      ? "incomplete"
      : "passed";

  // Validated on the way out so a report can never claim schema v1 while
  // drifting from it.
  return parseDoctorReport({
    schemaVersion: "1.0",
    status,
    generatedAt: new Date().toISOString(),
    artifactHashes,
    checks,
    findings,
    incompleteChecks,
    summary
  });
}

function parseStyleText(styleText: string): StyleSpecification {
  try {
    return JSON.parse(styleText) as StyleSpecification;
  } catch (error) {
    throw new Error(
      `Style is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function reportSampleHealth(
  sourceId: string,
  sample: TileSample,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"]
): void {
  if (sample.skipped) {
    incompleteChecks.push({
      id: `source.${sourceId}.tile-sample-skipped`,
      category: "tile-availability",
      sourceId,
      message: `Tile sampling skipped for ${sourceId}: ${sample.skipped}`
    });
    return;
  }

  if (sample.failures.length > 0) {
    incompleteChecks.push({
      id: `source.${sourceId}.tile-sample-failed`,
      category: "tile-availability",
      sourceId,
      message: `Could not sample every tile for ${sourceId}: ${sample.failures.join("; ")}`,
      evidence: { failures: sample.failures }
    });
  }

  if (sample.retrieved.length === 0 && sample.failures.length === 0) {
    findings.push({
      id: `source.${sourceId}.no-sampled-tiles`,
      severity: "risky",
      category: "tile-availability",
      sourceId,
      message: `No tile could be read from source ${sourceId} at any sampled address.`,
      evidence: { attempted: sample.attempted.map(formatAddress) }
    });
  }
}

/**
 * A canary reports what the map actually drew, so the evidence is ranked by how
 * conclusive it is. An HTTP error status is an artifact answering "no" and is
 * `broken`; a request that never completed proves nothing and is incomplete.
 */
function reportCanaryRun(
  run: CanaryRun,
  maxDiffRatio: number,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"]
): void {
  if (run.unavailable) {
    incompleteChecks.push({
      id: "canary.unavailable",
      category: "visual-canary",
      message: run.unavailable
    });
  }

  for (const source of run.unrenderableSources) {
    incompleteChecks.push({
      id: `canary.source.${source.id}.unrenderable`,
      category: "visual-canary",
      sourceId: source.id,
      message: `Source ${source.id} was left out of every visual canary because ${source.reason}.`
    });
  }

  for (const observation of run.observations) {
    reportCanary(observation, maxDiffRatio, findings, incompleteChecks);
  }
}

function reportCanary(
  observation: CanaryObservation,
  maxDiffRatio: number,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"]
): void {
  const id = observation.id;

  if (observation.incomplete) {
    incompleteChecks.push({
      id: `canary.${id}.incomplete`,
      category: "visual-canary",
      message: observation.incomplete
    });
  }

  if (observation.transportErrors.length > 0) {
    incompleteChecks.push({
      id: `canary.${id}.requests-unfinished`,
      category: "visual-canary",
      message: `Canary ${id} could not complete ${observation.transportErrors.length} request(s).`,
      evidence: { requests: observation.transportErrors }
    });
  }

  // An error status is an artifact answering "no", so it stands on its own.
  // Everything below reads what the map drew, which is only evidence when the
  // canary actually finished: a blocked request draws an empty map too.
  for (const httpError of observation.httpErrors) {
    findings.push({
      id: `canary.${id}.request-failed`,
      severity: "broken",
      category: "visual-canary",
      message: `Canary ${id} requested an artifact that answered with an error: ${httpError}`,
      evidence: { canary: id, request: httpError }
    });
  }

  if (observation.incomplete || observation.transportErrors.length > 0) {
    return;
  }

  for (const mapError of observation.mapErrors) {
    findings.push({
      id: `canary.${id}.map-error`,
      severity: "risky",
      category: "visual-canary",
      message: `Canary ${id} raised a MapLibre error while rendering: ${mapError}`,
      evidence: { canary: id }
    });
  }

  if (observation.featureCount === 0) {
    findings.push({
      id: `canary.${id}.no-features`,
      severity: "risky",
      category: "visual-canary",
      message: `Canary ${id} rendered no features at all.`,
      evidence: { canary: id, ...screenshotEvidence(observation) }
    });
  }

  for (const layerId of observation.expectedButEmpty ?? []) {
    findings.push({
      id: `canary.${id}.layer.${layerId}.empty`,
      severity: "broken",
      category: "visual-canary",
      layerId,
      message: `Canary ${id} expected layer ${layerId} to render, but it drew no features.`,
      evidence: {
        canary: id,
        renderedLayers: Object.keys(observation.featuresByLayer),
        ...screenshotEvidence(observation)
      }
    });
  }

  if (observation.baselineMissing) {
    findings.push({
      id: `canary.${id}.baseline-missing`,
      severity: "info",
      category: "visual-canary",
      path: observation.baselinePath,
      message: `Canary ${id} has no baseline to compare against yet.`,
      evidence: screenshotEvidence(observation)
    });
    return;
  }

  if (observation.diffRatio !== undefined && observation.diffRatio > maxDiffRatio) {
    findings.push({
      id: `canary.${id}.baseline-diff`,
      severity: "risky",
      category: "visual-canary",
      path: observation.baselinePath,
      message: `Canary ${id} differs from its baseline in ${observation.diffPixels} pixel(s) (${(observation.diffRatio * 100).toFixed(2)}%).`,
      evidence: {
        canary: id,
        diffPixels: observation.diffPixels,
        diffRatio: observation.diffRatio,
        maxDiffRatio,
        ...screenshotEvidence(observation)
      }
    });
  }
}

function screenshotEvidence(observation: CanaryObservation): Record<string, unknown> {
  return {
    ...(observation.screenshotPath === undefined ? {} : { screenshot: observation.screenshotPath }),
    ...(observation.diffPath === undefined ? {} : { diff: observation.diffPath })
  };
}

function canaryStatus(
  run: CanaryRun,
  findings: Finding[]
): DoctorReport["checks"][number]["status"] {
  if (run.unavailable || run.unrenderableSources.length > 0) {
    return "incomplete";
  }
  if (
    run.observations.some(
      (observation) => observation.incomplete || observation.transportErrors.length > 0
    )
  ) {
    return "incomplete";
  }
  return findings.some(
    (finding) => finding.category === "visual-canary" && finding.severity !== "info"
  )
    ? "failed"
    : "passed";
}

function tileSampleStatus(
  enabled: boolean,
  contracts: Map<string, SourceContract>,
  samples: Map<string, TileSample>
): DoctorReport["checks"][number]["status"] {
  if (!enabled || contracts.size === 0) {
    return "incomplete";
  }
  const usable = [...samples.values()].filter(
    (sample) => !sample.skipped && sample.failures.length === 0
  );
  return usable.length === samples.size ? "passed" : "incomplete";
}

function inspectLayer(
  layer: LayerSpecification,
  style: StyleSpecification,
  contracts: Map<string, SourceContract>,
  samples: Map<string, TileSample>,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"],
  absenceSeverity: Severity
): void {
  const layerRecord = layer as Record<string, unknown>;
  const layerId = typeof layer.id === "string" ? layer.id : "unknown-layer";
  const sourceId = typeof layerRecord.source === "string" ? layerRecord.source : undefined;
  const sourceLayer =
    typeof layerRecord["source-layer"] === "string" ? layerRecord["source-layer"] : undefined;

  if (!sourceId) {
    return;
  }

  if (!style.sources?.[sourceId]) {
    findings.push({
      id: `layer.${layerId}.missing-source`,
      severity: "broken",
      category: "source",
      layerId,
      sourceId,
      message: `Layer ${layerId} references missing source ${sourceId}.`,
      suggestion: nearest(sourceId, Object.keys(style.sources ?? {}))
    });
    return;
  }

  const contract = contracts.get(sourceId);
  if (!contract) {
    return;
  }

  if (sourceLayer) {
    inspectSourceLayer(
      layerId,
      sourceId,
      sourceLayer,
      contract,
      samples.get(sourceId),
      findings,
      incompleteChecks,
      absenceSeverity
    );
  }

  const layerMin = typeof layer.minzoom === "number" ? layer.minzoom : 0;
  const layerMax = typeof layer.maxzoom === "number" ? layer.maxzoom : 24;
  const sourceMin = contract.minzoom ?? 0;
  const sourceMax = contract.maxzoom ?? 24;
  // Only the minzoom side of the source range is a contract. MapLibre overzooms:
  // above `sourceMax` it keeps rendering by scaling the deepest tiles it has, so
  // a layer drawn only above `sourceMax` — a maxzoom-14 basemap showing buildings
  // at z18 — is how vector maps are built, not a break. It does not underzoom,
  // so below `sourceMin` there is genuinely nothing to draw.
  if (layerMax < sourceMin) {
    findings.push({
      id: `layer.${layerId}.zoom-below-source`,
      severity: "broken",
      category: "zoom",
      layerId,
      sourceId,
      sourceLayer,
      message: `Layer ${layerId} zoom range ${layerMin}-${layerMax} ends below source ${sourceId} minzoom ${sourceMin}, so it can never render.`,
      evidence: { layerMin, layerMax, sourceMin, sourceMax }
    });
  } else if (layerMin < sourceMin) {
    findings.push({
      id: `layer.${layerId}.zoom-starts-below-source`,
      severity: "risky",
      category: "zoom",
      layerId,
      sourceId,
      sourceLayer,
      message: `Layer ${layerId} zoom range ${layerMin}-${layerMax} starts below source ${sourceId} minzoom ${sourceMin}, so it renders nothing until zoom ${sourceMin}.`,
      evidence: { layerMin, layerMax, sourceMin, sourceMax }
    });
  }
}

/**
 * Declared `vector_layers` metadata is authoritative when present. Without it,
 * sampled tiles are the only evidence available, and a source-layer absent from
 * a partial sample is suspicious rather than proven missing.
 */
function inspectSourceLayer(
  layerId: string,
  sourceId: string,
  sourceLayer: string,
  contract: SourceContract,
  sample: TileSample | undefined,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"],
  absenceSeverity: Severity
): void {
  if (contract.vectorLayers.length > 0) {
    if (contract.vectorLayers.some((candidate) => candidate.id === sourceLayer)) {
      return;
    }
    findings.push({
      id: `layer.${layerId}.missing-source-layer`,
      severity: "broken",
      category: "source-layer",
      layerId,
      sourceId,
      sourceLayer,
      message: `Layer ${layerId} references missing source-layer ${sourceLayer}.`,
      suggestion: nearest(
        sourceLayer,
        contract.vectorLayers.map((candidate) => candidate.id)
      ),
      evidence: {
        availableSourceLayers: contract.vectorLayers.map((candidate) => candidate.id)
      }
    });
    return;
  }

  const sampledLayers = sample ? [...sample.layers.keys()] : [];
  if (sampledLayers.length === 0) {
    incompleteChecks.push({
      id: `layer.${layerId}.source-layer-unverified`,
      category: "source-layer",
      sourceId,
      message: `Source ${sourceId} declares no vector layers and no tile could be sampled, so source-layer ${sourceLayer} could not be verified.`
    });
    return;
  }

  if (!sampledLayers.includes(sourceLayer)) {
    findings.push({
      id: `layer.${layerId}.source-layer-not-sampled`,
      severity: absenceSeverity,
      category: "source-layer",
      layerId,
      sourceId,
      sourceLayer,
      message: `Layer ${layerId} references source-layer ${sourceLayer}, which no sampled tile of source ${sourceId} contains.`,
      suggestion: nearest(sourceLayer, sampledLayers),
      evidence: {
        sampledSourceLayers: sampledLayers,
        sampledTiles: (sample?.retrieved ?? []).map(formatAddress)
      }
    });
  }
}

async function inspectSprite(
  style: StyleSpecification,
  usage: StyleUsage,
  layers: unknown[],
  samples: Map<string, TileSample>,
  styleDir: string,
  timeoutMs: number,
  allowNetwork: boolean,
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"]
): Promise<void> {
  const iconImages = usage.iconImages;
  if (!style.sprite || (iconImages.size === 0 && usage.iconTemplates.length === 0)) {
    return;
  }

  const sources = spriteSources(style.sprite);
  if (sources.length === 0) {
    return;
  }
  // The array form of `sprite` declares several sprites and namespaces every
  // icon reference as `<sprite-id>:<icon-name>`. The string form declares one
  // unnamed sprite whose icons are referenced bare, and where a colon is just a
  // character in the name.
  const namespaced = Array.isArray(style.sprite);

  const loaded = new Map<string, { index: Record<string, unknown>; path: string }>();
  const unreadable = new Set<string>();

  for (const source of sources) {
    const key = source.id ?? "";
    const spriteJson = resolveLocation(`${source.url}.json`, styleDir);
    const suffix = source.id ? `.${source.id}` : "";

    if (!allowNetwork && isHttpUrl(spriteJson)) {
      unreadable.add(key);
      incompleteChecks.push({
        id: `sprite${suffix}.network-disabled`,
        category: "sprite",
        path: spriteJson,
        message: "Sprite index is remote and network access is disabled."
      });
      continue;
    }

    try {
      loaded.set(key, {
        index: await readJson<Record<string, unknown>>(spriteJson, timeoutMs),
        path: spriteJson
      });
    } catch (error) {
      unreadable.add(key);
      incompleteChecks.push({
        id: `sprite${suffix}.index-unreadable`,
        category: "sprite",
        path: spriteJson,
        message: `Could not read sprite index: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const declared = new Set(sources.map((source) => source.id ?? ""));

  /**
   * Splits a reference into the sprite it names and the icon inside it, then
   * says what the sprite index proves about it. Static and data-driven names
   * resolve identically; only what a miss means differs.
   */
  function resolve(
    icon: string
  ):
    | { kind: "found" }
    | { kind: "unverifiable" }
    | { kind: "unknown-sprite"; spriteId: string }
    | { kind: "missing"; spriteId: string; name: string; path: string; suggestion?: string } {
    const separator = namespaced ? icon.indexOf(":") : -1;
    const spriteId = separator === -1 ? "" : icon.slice(0, separator);
    const name = separator === -1 ? icon : icon.slice(separator + 1);

    if (!declared.has(spriteId)) {
      return { kind: "unknown-sprite", spriteId };
    }
    // A sprite whose index could not be read is already an incomplete check.
    // Reporting its icons missing would turn "could not verify" into "broken".
    if (unreadable.has(spriteId)) {
      return { kind: "unverifiable" };
    }

    const entry = loaded.get(spriteId);
    if (!entry) {
      return { kind: "unverifiable" };
    }
    if (entry.index[name]) {
      return { kind: "found" };
    }

    const nearestIcon = nearest(name, Object.keys(entry.index));
    const suggestion = nearestIcon && spriteId ? `${spriteId}:${nearestIcon}` : nearestIcon;
    return {
      kind: "missing",
      spriteId,
      name,
      path: entry.path,
      ...(suggestion === undefined ? {} : { suggestion })
    };
  }

  for (const icon of iconImages) {
    const resolved = resolve(icon);
    if (resolved.kind === "unknown-sprite") {
      findings.push({
        id: `sprite.icon.${icon}.unknown-sprite`,
        severity: "broken",
        category: "icon",
        message: `Icon ${icon} names sprite ${resolved.spriteId || "<unprefixed>"}, which the style does not declare.`,
        suggestion: nearest(resolved.spriteId, [...declared].filter(Boolean))
      });
      continue;
    }
    if (resolved.kind === "missing") {
      findings.push({
        id: `sprite.icon.${icon}.missing`,
        severity: "broken",
        category: "icon",
        message: `Icon ${icon} is referenced by the style but missing from the sprite index.`,
        path: resolved.path,
        suggestion: resolved.suggestion
      });
    }
  }

  inspectDataDrivenIcons(usage.iconTemplates, layers, samples, resolve, findings, incompleteChecks);
}

/**
 * An `icon-image` built from feature data has no name until a feature supplies
 * one, so the sampled tiles are the only place its names exist. Each sampled
 * combination of the properties it reads produces one candidate name, which the
 * sprite index can then answer for.
 */
function inspectDataDrivenIcons(
  templates: IconNameTemplate[],
  layers: unknown[],
  samples: Map<string, TileSample>,
  resolve: (icon: string) => { kind: string; path?: string; suggestion?: string | undefined },
  findings: Finding[],
  incompleteChecks: DoctorReport["incompleteChecks"]
): void {
  if (templates.length === 0) {
    return;
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const layer of layers) {
    const record = layer as Record<string, unknown>;
    if (typeof record.id === "string") {
      byId.set(record.id, record);
    }
  }

  for (const template of templates) {
    const layer = byId.get(template.layerId);
    const sourceId = typeof layer?.source === "string" ? layer.source : undefined;
    const sourceLayer =
      typeof layer?.["source-layer"] === "string" ? layer["source-layer"] : undefined;
    const properties = [
      ...new Set(template.parts.flatMap((part) => ("property" in part ? [part.property] : [])))
    ];

    const sampled =
      sourceId && sourceLayer ? samples.get(sourceId)?.layers.get(sourceLayer) : undefined;
    const combinations = sampled?.valueCombinations ?? [];

    if (combinations.length === 0) {
      incompleteChecks.push({
        id: `layer.${template.layerId}.icon-from-data.${properties.join("+")}`,
        category: "icon",
        ...(sourceId === undefined ? {} : { sourceId }),
        message: `Layer ${template.layerId} builds its icon name from ${properties.join(", ")}, and no sampled feature supplied those values, so the icons it renders could not be checked.`,
        evidence: { properties }
      });
      continue;
    }

    const missing = new Map<string, { suggestion?: string | undefined; path?: string }>();
    let checked = 0;
    for (const combination of combinations) {
      const name = renderIconName(template.parts, combination);
      if (name === undefined) {
        continue;
      }
      checked += 1;
      const resolved = resolve(name);
      if (resolved.kind === "missing" || resolved.kind === "unknown-sprite") {
        missing.set(name, {
          suggestion: resolved.suggestion,
          ...(resolved.path === undefined ? {} : { path: resolved.path })
        });
      }
    }

    if (checked === 0) {
      incompleteChecks.push({
        id: `layer.${template.layerId}.icon-from-data.${properties.join("+")}`,
        category: "icon",
        ...(sourceId === undefined ? {} : { sourceId }),
        message: `Layer ${template.layerId} builds its icon name from ${properties.join(", ")}, and no sampled feature carried every one of those properties, so the icons it renders could not be checked.`,
        evidence: { properties }
      });
      continue;
    }

    for (const [name, detail] of missing) {
      findings.push({
        id: `layer.${template.layerId}.icon-from-data.${name}.missing`,
        // The sprite index is authoritative that the icon is absent, but only a
        // partial sample says the value occurs, and the project's rule is that a
        // partial sample never fails a build on its own.
        severity: "risky",
        category: "icon",
        layerId: template.layerId,
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(sourceLayer === undefined ? {} : { sourceLayer }),
        message: `Layer ${template.layerId} builds its icon name from ${properties.join(", ")}; sampled features produce ${name}, which is missing from the sprite index.`,
        ...(detail.path === undefined ? {} : { path: detail.path }),
        suggestion: detail.suggestion,
        evidence: {
          properties,
          sampledCombinations: checked,
          ...(sampled?.truncatedCombinations ? { truncatedSample: true } : {})
        }
      });
    }
  }
}

async function inspectGlyphs(
  style: StyleSpecification,
  fontStacks: Set<string>,
  styleDir: string,
  timeoutMs: number,
  allowNetwork: boolean,
  incompleteChecks: DoctorReport["incompleteChecks"]
): Promise<void> {
  if (!style.glyphs || fontStacks.size === 0) {
    return;
  }

  // Percent-encoding is only correct for URL templates; a local glyph directory
  // is named after the raw font stack, spaces included.
  const encodeFontStack = isHttpUrl(style.glyphs);

  if (!allowNetwork && encodeFontStack) {
    incompleteChecks.push({
      id: "glyph.network-disabled",
      category: "glyph",
      path: style.glyphs,
      message: "Glyph endpoint is remote and network access is disabled."
    });
    return;
  }

  for (const fontStack of fontStacks) {
    const glyphPath = style.glyphs
      .replace("{fontstack}", encodeFontStack ? encodeURIComponent(fontStack) : fontStack)
      .replace("{range}", "0-255");
    const resolved = resolveLocation(glyphPath, styleDir);
    try {
      const ok = await headOrGetOk(resolved, timeoutMs);
      if (!ok) {
        incompleteChecks.push({
          id: `glyph.${fontStack}.unreachable`,
          category: "glyph",
          path: resolved,
          message: `Glyph endpoint for font stack ${fontStack} is not reachable.`
        });
      }
    } catch (error) {
      incompleteChecks.push({
        id: `glyph.${fontStack}.check-failed`,
        category: "glyph",
        path: resolved,
        message: `Could not verify glyph endpoint for ${fontStack}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

function inspectExpressionProperties(
  layers: LayerSpecification[],
  contracts: Map<string, SourceContract>,
  samples: Map<string, TileSample>,
  propertiesByLayer: Map<string, Set<string>>,
  findings: Finding[],
  absenceSeverity: Severity
): void {
  for (const layer of layers) {
    const layerRecord = layer as Record<string, unknown>;
    const layerId = typeof layer.id === "string" ? layer.id : "unknown-layer";
    const sourceId = typeof layerRecord.source === "string" ? layerRecord.source : undefined;
    const sourceLayer =
      typeof layerRecord["source-layer"] === "string" ? layerRecord["source-layer"] : undefined;
    const properties = propertiesByLayer.get(layerId);
    if (!sourceId || !sourceLayer || !properties?.size) {
      continue;
    }

    const contract = contracts.get(sourceId);
    const declaredFields = contract?.vectorLayers.find(
      (candidate) => candidate.id === sourceLayer
    )?.fields;
    const sampled = samples.get(sourceId)?.layers.get(sourceLayer);

    for (const property of properties) {
      const declared = declaredFields ? Boolean(declaredFields[property]) : undefined;
      const observed = sampled ? sampled.properties.has(property) : undefined;

      // Sampled features outrank stale metadata in both directions.
      if (observed === true) {
        continue;
      }

      if (declared === false) {
        findings.push({
          id: `layer.${layerId}.property.${property}.not-observed`,
          severity: "risky",
          category: "expression-property",
          layerId,
          sourceId,
          sourceLayer,
          property,
          message: `Layer ${layerId} references property ${property}, but it is not declared in source-layer ${sourceLayer} metadata.`,
          suggestion: nearest(property, Object.keys(declaredFields ?? {})),
          evidence: {
            fields: Object.keys(declaredFields ?? {}),
            ...(observed === false ? { sampledProperties: [...sampled!.properties] } : {})
          }
        });
        continue;
      }

      if (observed === false && declared === undefined) {
        findings.push({
          id: `layer.${layerId}.property.${property}.not-observed`,
          severity: absenceSeverity,
          category: "expression-property",
          layerId,
          sourceId,
          sourceLayer,
          property,
          message: `Layer ${layerId} references property ${property}, which no sampled feature of source-layer ${sourceLayer} carries and no metadata declares.`,
          suggestion: nearest(property, [...sampled!.properties]),
          evidence: { sampledProperties: [...sampled!.properties] }
        });
        continue;
      }

      if (observed === false && declared === true) {
        findings.push({
          id: `layer.${layerId}.property.${property}.not-sampled`,
          severity: "info",
          category: "expression-property",
          layerId,
          sourceId,
          sourceLayer,
          property,
          message: `Layer ${layerId} references property ${property}, which source-layer ${sourceLayer} declares but no sampled feature carries.`,
          evidence: {
            sampledProperties: [...sampled!.properties],
            sampledFeatures: sampled!.featureCount
          }
        });
      }
    }
  }
}

function formatAddress(address: { z: number; x: number; y: number }): string {
  return `${address.z}/${address.x}/${address.y}`;
}

function sourceLocationFromStyleSource(source: unknown): string | undefined {
  const record = source as Record<string, unknown>;
  return typeof record.url === "string" ? record.url : undefined;
}

/** A source that declares its own tile templates needs no fetch to be read. */
function declaresTilesInline(source: unknown): boolean {
  const record = source as Record<string, unknown>;
  return (
    typeof record.url !== "string" &&
    Array.isArray(record.tiles) &&
    record.tiles.some((item) => typeof item === "string")
  );
}

function stripPmtilesProtocol(location: string): string {
  return location.startsWith("pmtiles://") ? location.slice("pmtiles://".length) : location;
}

/**
 * Every sprite the style declares, not just the first. `id` is set only in the
 * array form, which is what makes icon references namespaced.
 */
function spriteSources(sprite: StyleSpecification["sprite"]): { id?: string; url: string }[] {
  if (typeof sprite === "string") {
    return [{ url: sprite }];
  }
  if (!Array.isArray(sprite)) {
    return [];
  }
  return sprite.flatMap((entry) => {
    if (entry && typeof entry === "object" && "url" in entry) {
      const id = "id" in entry && typeof entry.id === "string" ? entry.id : undefined;
      return [id === undefined ? { url: String(entry.url) } : { id, url: String(entry.url) }];
    }
    return [];
  });
}

function nearest(target: string, candidates: string[]): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  return best && best.distance <= Math.max(3, Math.floor(target.length / 2))
    ? best.candidate
    : undefined;
}

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= b.length; column += 1) {
    rows[0]![column] = column;
  }
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      rows[row]![column] =
        a[row - 1] === b[column - 1]
          ? rows[row - 1]![column - 1]!
          : Math.min(
              rows[row - 1]![column - 1]!,
              rows[row]![column - 1]!,
              rows[row - 1]![column]!
            ) + 1;
    }
  }
  return rows[a.length]![b.length]!;
}
