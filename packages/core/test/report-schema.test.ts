import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStyleContract } from "../src/index.js";
import {
  doctorReportJsonSchema,
  doctorReportSchema,
  parseDoctorReport
} from "../src/report-schema.js";

const root = resolve(import.meta.dirname, "../../..");

function validReport() {
  return {
    schemaVersion: "1.0",
    status: "failed",
    generatedAt: "2026-07-30T00:00:00.000Z",
    artifactHashes: { "/tmp/style.json": "sha256:abc" },
    checks: [{ id: "style-spec", status: "failed", message: "Errors found." }],
    findings: [
      {
        id: "layer.a.missing-source-layer",
        severity: "broken",
        category: "source-layer",
        message: "Missing."
      }
    ],
    incompleteChecks: [],
    summary: { broken: 1, risky: 0, warning: 0, info: 0, incomplete: 0 }
  };
}

describe("doctorReportSchema", () => {
  it("accepts a report the checker actually produced", async () => {
    const report = await checkStyleContract({
      stylePath: resolve(root, "fixtures/broken-style/style.json"),
      sources: [
        { id: "openmaptiles", location: resolve(root, "fixtures/simple-style/tilejson.json") }
      ]
    });

    expect(doctorReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts a minimal valid report", () => {
    expect(() => parseDoctorReport(validReport())).not.toThrow();
  });

  it("rejects an unknown severity and names the failing path", () => {
    const report = validReport();
    report.findings[0]!.severity = "catastrophic";

    expect(() => parseDoctorReport(report)).toThrow(/findings\.0\.severity/);
  });

  it("rejects a different schema version", () => {
    const report = { ...validReport(), schemaVersion: "2.0" };

    expect(() => parseDoctorReport(report)).toThrow(/schemaVersion/);
  });

  it("rejects a missing summary", () => {
    const report: Record<string, unknown> = validReport();
    delete report.summary;

    expect(() => parseDoctorReport(report)).toThrow(/summary/);
  });

  it("rejects a negative count", () => {
    const report = validReport();
    report.summary.broken = -1;

    expect(() => parseDoctorReport(report)).toThrow(/summary\.broken/);
  });

  it("rejects a non-timestamp generatedAt", () => {
    const report = { ...validReport(), generatedAt: "yesterday" };

    expect(() => parseDoctorReport(report)).toThrow(/generatedAt/);
  });
});

describe("doctorReportJsonSchema", () => {
  it("emits a 2020-12 JSON Schema describing the report envelope", () => {
    const schema = doctorReportJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      "schemaVersion",
      "status",
      "generatedAt",
      "artifactHashes",
      "checks",
      "findings",
      "incompleteChecks",
      "summary"
    ]);
    expect(schema.required).toEqual([
      "schemaVersion",
      "status",
      "generatedAt",
      "artifactHashes",
      "checks",
      "findings",
      "incompleteChecks",
      "summary"
    ]);
  });

  it("describes every finding category and severity", () => {
    const schema = JSON.stringify(doctorReportJsonSchema());

    for (const category of ["source-layer", "tile-availability", "visual-canary"]) {
      expect(schema).toContain(category);
    }
    for (const severity of ["broken", "risky", "warning", "info"]) {
      expect(schema).toContain(severity);
    }
  });
});
