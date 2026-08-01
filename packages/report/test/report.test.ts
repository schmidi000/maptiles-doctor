import type { DoctorReport } from "@maptiles-doctor/core";
import { describe, expect, it } from "vitest";
import { renderHtmlReport, renderSarif } from "../src/index.js";

const report: DoctorReport = {
  schemaVersion: "1.0",
  status: "failed",
  generatedAt: "2026-07-30T00:00:00.000Z",
  artifactHashes: { "/tmp/style.json": "sha256:abc" },
  checks: [{ id: "style-spec", status: "failed", message: "Style specification errors found." }],
  findings: [
    {
      id: "layer.a.missing-source-layer",
      severity: "broken",
      category: "source-layer",
      message: "Layer a references missing source-layer <building>.",
      path: "/tmp/style.json"
    },
    {
      id: "layer.a.missing-source-layer",
      severity: "risky",
      category: "expression-property",
      message: "Layer a references property height."
    },
    {
      id: "source.ghost.unused",
      severity: "warning",
      category: "source",
      message: "Unused override."
    },
    {
      id: "layer.a.note",
      severity: "info",
      category: "zoom",
      message: "Informational."
    }
  ],
  incompleteChecks: [
    {
      id: "glyph.Noto Sans Regular.unreachable",
      category: "glyph",
      message: "Glyph endpoint is not reachable.",
      path: "https://example.invalid/fonts"
    }
  ],
  summary: { broken: 1, risky: 1, warning: 1, info: 1, incomplete: 1 }
};

describe("renderSarif", () => {
  it("emits a SARIF 2.1.0 run with one rule per distinct finding id", () => {
    const sarif = JSON.parse(renderSarif(report));

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("MapTiles Doctor");
    expect(sarif.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual([
      "layer.a.missing-source-layer",
      "source.ghost.unused",
      "layer.a.note"
    ]);
  });

  it("maps severities onto SARIF levels", () => {
    const sarif = JSON.parse(renderSarif(report));

    expect(sarif.runs[0].results.map((result: { level: string }) => result.level)).toEqual([
      "error",
      "warning",
      "warning",
      "note"
    ]);
  });

  it("includes a physical location only for findings that carry a path", () => {
    const sarif = JSON.parse(renderSarif(report));
    const [withPath, withoutPath] = sarif.runs[0].results;

    expect(withPath.locations[0].physicalLocation.artifactLocation.uri).toBe("/tmp/style.json");
    expect(withoutPath.locations).toEqual([]);
  });
});

describe("renderHtmlReport", () => {
  it("renders the status, summary counts, and one row per finding", () => {
    const html = renderHtmlReport(report);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('class="status-failed"');
    expect(html).toContain("<li>Broken: 1</li>");
    expect(html).toContain("<li>Incomplete: 1</li>");
    // One header row plus a row per finding and per incomplete check.
    expect(html.match(/<tr>/g)).toHaveLength(
      1 + report.findings.length + report.incompleteChecks.length
    );
  });

  it("renders incomplete checks alongside findings", () => {
    const html = renderHtmlReport(report);

    expect(html).toContain("<td>incomplete</td>");
    expect(html).toContain("Glyph endpoint is not reachable.");
  });

  it("escapes markup in finding messages", () => {
    const html = renderHtmlReport(report);

    expect(html).toContain("&lt;building&gt;");
    expect(html).not.toContain("<building>");
  });
});
