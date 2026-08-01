export { rewriteStyleForBrowser, runVisualCanaries } from "./canary.js";
export { checkCategories, checkStyleContract } from "./checker.js";
export { collectStyleUsage } from "./expression.js";
export {
  doctorReportJsonSchema,
  doctorReportSchema,
  findingCategories,
  parseDoctorReport
} from "./report-schema.js";
export { readSourceContract } from "./source-reader.js";
export { sampleAddresses, sampleSourceTiles } from "./tile-sampler.js";
export type {
  CanaryObservation,
  CanaryRun,
  CanarySpec,
  CheckResult,
  CheckStatus,
  DoctorCheckOptions,
  DoctorReport,
  DoctorSourceInput,
  Finding,
  FindingCategory,
  IncompleteCheck,
  ReportStatus,
  SampledLayer,
  Severity,
  SourceContract,
  TileAddress,
  TileSample,
  VectorLayerContract
} from "./types.js";
export { severityRank } from "./types.js";
