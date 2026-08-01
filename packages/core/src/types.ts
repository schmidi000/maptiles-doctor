export type Severity = "broken" | "risky" | "warning" | "info";

export type CheckStatus = "passed" | "failed" | "incomplete";

export type ReportStatus = "passed" | "failed" | "incomplete";

export type FindingCategory =
  | "style-spec"
  | "source"
  | "source-layer"
  | "zoom"
  | "glyph"
  | "sprite"
  | "icon"
  | "expression-property"
  | "tile-availability"
  | "visual-canary";

export interface DoctorSourceInput {
  id: string;
  location: string;
}

export interface DoctorCheckOptions {
  stylePath: string;
  /**
   * Style JSON to check instead of the contents of `stylePath`. An editor uses
   * it to check an unsaved buffer; `stylePath` still resolves relative sprite,
   * glyph, and source locations.
   */
  styleText?: string;
  sources?: DoctorSourceInput[];
  failThreshold?: Severity;
  /** When false, remote artifacts are reported incomplete instead of fetched. */
  allowNetwork?: boolean;
  /** When false, contract checks rely on declared metadata only. */
  sampleTiles?: boolean;
  /**
   * Severity for findings that rest only on something being absent from a
   * partial sample, where no metadata says either way. Defaults to `info`: three
   * tiles will not contain a rare feature even in a healthy tileset, so absence
   * there is weak evidence. Raise it for a dense tileset where absence is worth
   * acting on. It can never be `broken`, because a sample cannot prove absence.
   */
  sampledAbsenceSeverity?: "info" | "warning" | "risky";
  /** Number of tile addresses probed per source. Defaults to 3. */
  maxSampleTiles?: number;
  /**
   * Longitude and latitude to sample tiles at. Overrides the built-in populated
   * anchors, for a source whose data sits somewhere they do not cover.
   */
  sampleAt?: [number, number] | undefined;
  /**
   * Views to render with MapLibre GL in a headless browser. Visual canaries are
   * off unless at least one is configured, because they need optional packages
   * and a browser that a deterministic run must not depend on.
   */
  canaries?: CanarySpec[];
  /** Directory canary screenshots and diffs are written to. */
  screenshotDir?: string;
  /** Directory of `<canary-id>.png` baselines to compare renders against. */
  baselineDir?: string;
  /** Fraction of differing pixels tolerated before a diff is reported. Defaults to 0.005. */
  maxDiffRatio?: number;
  timeoutMs?: number;
}

export interface CanarySpec {
  id: string;
  /** Longitude and latitude of the view center. */
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
  /** Viewport size in CSS pixels. Defaults to 512x512. */
  width?: number;
  height?: number;
  /** Layer ids that must render at least one feature in this view. */
  expectLayers?: string[];
}

export interface CanaryObservation {
  id: string;
  featureCount: number;
  featuresByLayer: Record<string, number>;
  /** Deduplicated MapLibre `error` events raised while rendering. */
  mapErrors: string[];
  /** Requests the server answered with an error status. */
  httpErrors: string[];
  /** Requests that never completed: DNS, connection, timeout, or blocked. */
  transportErrors: string[];
  /** Layer ids from `expectLayers` that rendered nothing. */
  expectedButEmpty?: string[];
  screenshotPath?: string;
  baselinePath?: string;
  diffPath?: string;
  diffPixels?: number;
  diffRatio?: number;
  /** Set when no baseline exists yet for this canary. */
  baselineMissing?: boolean;
  /** Set when the canary could not be rendered or compared. */
  incomplete?: string;
}

export interface CanaryRun {
  observations: CanaryObservation[];
  /** Set when no canary could run at all: no browser, or no renderer. */
  unavailable?: string;
  /** Sources dropped before rendering because a browser cannot read them. */
  unrenderableSources: Array<{ id: string; reason: string }>;
}

export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

export interface SampledLayer {
  featureCount: number;
  properties: Set<string>;
  /**
   * Distinct combinations of the properties an `icon-image` builds a name from,
   * taken per feature so a name is only ever built from values that really
   * occur together. Empty unless the style has a data-driven `icon-image`, and
   * bounded, so `truncated` marks that further combinations were not kept.
   */
  valueCombinations: Record<string, string>[];
  truncatedCombinations?: boolean | undefined;
}

export interface TileSample {
  attempted: TileAddress[];
  retrieved: TileAddress[];
  layers: Map<string, SampledLayer>;
  failures: string[];
  /** Set when sampling did not run at all. */
  skipped?: string;
}

export interface SourceContract {
  id: string;
  location: string;
  kind: "pmtiles" | "mbtiles" | "tilejson" | "raster" | "style" | "unknown";
  vectorLayers: VectorLayerContract[];
  minzoom?: number | undefined;
  maxzoom?: number | undefined;
  bounds?: [number, number, number, number] | undefined;
  glyphs?: string | undefined;
  sprite?: string | undefined;
  tileUrls?: string[] | undefined;
}

export interface VectorLayerContract {
  id: string;
  minzoom?: number | undefined;
  maxzoom?: number | undefined;
  fields?: Record<string, string> | undefined;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: FindingCategory;
  message: string;
  layerId?: string | undefined;
  sourceId?: string | undefined;
  sourceLayer?: string | undefined;
  property?: string | undefined;
  path?: string | undefined;
  suggestion?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
}

export interface IncompleteCheck {
  id: string;
  category: FindingCategory;
  message: string;
  sourceId?: string | undefined;
  path?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  schemaVersion: "1.0";
  status: ReportStatus;
  generatedAt: string;
  artifactHashes: Record<string, string>;
  checks: CheckResult[];
  findings: Finding[];
  incompleteChecks: IncompleteCheck[];
  summary: {
    broken: number;
    risky: number;
    warning: number;
    info: number;
    incomplete: number;
  };
}

export const severityRank: Record<Severity, number> = {
  info: 0,
  warning: 1,
  risky: 2,
  broken: 3
};
