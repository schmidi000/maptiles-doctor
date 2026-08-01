import { z } from "zod";
import type { DoctorReport } from "./types.js";

const severity = z.enum(["broken", "risky", "warning", "info"]);
const checkStatus = z.enum(["passed", "failed", "incomplete"]);
const category = z.enum([
  "style-spec",
  "source",
  "source-layer",
  "zoom",
  "glyph",
  "sprite",
  "icon",
  "expression-property",
  "tile-availability",
  "visual-canary"
]);

const evidence = z.record(z.string(), z.unknown());

const findingSchema = z.object({
  id: z.string(),
  severity,
  category,
  message: z.string(),
  layerId: z.string().optional(),
  sourceId: z.string().optional(),
  sourceLayer: z.string().optional(),
  property: z.string().optional(),
  path: z.string().optional(),
  suggestion: z.string().optional(),
  evidence: evidence.optional()
});

const incompleteCheckSchema = z.object({
  id: z.string(),
  category,
  message: z.string(),
  sourceId: z.string().optional(),
  path: z.string().optional(),
  evidence: evidence.optional()
});

/** Runtime contract for report schema v1. Consumers can pin against this. */
export const doctorReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: checkStatus,
  generatedAt: z.iso.datetime(),
  artifactHashes: z.record(z.string(), z.string()),
  checks: z.array(z.object({ id: z.string(), status: checkStatus, message: z.string() })),
  findings: z.array(findingSchema),
  incompleteChecks: z.array(incompleteCheckSchema),
  summary: z.object({
    broken: z.number().int().nonnegative(),
    risky: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative()
  })
});

/** Throws with the failing paths when the value is not a valid report. */
export function parseDoctorReport(value: unknown): DoctorReport {
  const result = doctorReportSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Report does not match schema v1: ${issues}`);
  }
  return value as DoctorReport;
}

export function doctorReportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(doctorReportSchema, { io: "output" }) as Record<string, unknown>;
}
