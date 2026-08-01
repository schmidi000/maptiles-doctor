import type { DoctorReport, Finding, Severity } from "@maptiles-doctor/core";
import { describe, expect, it } from "vitest";
import { formatGithubAnnotations, formatPretty } from "../src/format.js";

function finding(overrides: Partial<Finding> & Pick<Finding, "severity">): Finding {
  return {
    id: "finding",
    category: "source-layer",
    message: "something happened",
    ...overrides
  };
}

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const findings = overrides.findings ?? [];
  return {
    schemaVersion: "1.0",
    status: "passed",
    generatedAt: "2026-08-01T00:00:00.000Z",
    artifactHashes: {},
    checks: [],
    findings,
    incompleteChecks: [],
    summary: {
      broken: findings.filter((item) => item.severity === "broken").length,
      risky: findings.filter((item) => item.severity === "risky").length,
      warning: findings.filter((item) => item.severity === "warning").length,
      info: findings.filter((item) => item.severity === "info").length,
      incomplete: overrides.incompleteChecks?.length ?? 0
    },
    ...overrides
  };
}

describe("formatPretty", () => {
  it("labels every severity distinctly", () => {
    const severities: Severity[] = ["broken", "risky", "warning", "info"];
    const output = formatPretty(
      report({
        findings: severities.map((severity) => finding({ severity, message: `a ${severity} one` }))
      })
    );

    for (const severity of severities) {
      expect(output).toContain(`${severity} a ${severity} one`);
    }
  });

  it.each([
    ["passed", "✓"],
    ["failed", "✖"],
    ["incomplete", "!"]
  ] as const)("marks a %s report with %s", (status, mark) => {
    expect(formatPretty(report({ status }))).toContain(`${mark} MapTiles Doctor: ${status}`);
  });

  it("appends a suggestion only when there is one", () => {
    const output = formatPretty(
      report({
        findings: [
          finding({ severity: "broken", message: "no layer", suggestion: "buildings" }),
          finding({ severity: "broken", message: "no idea" })
        ]
      })
    );

    expect(output).toContain("no layer Suggestion: buildings.");
    expect(output).toContain("no idea\n");
    expect(output).not.toContain("no idea Suggestion");
  });

  it("lists incomplete checks after the findings", () => {
    const output = formatPretty(
      report({
        status: "incomplete",
        findings: [finding({ severity: "risky", message: "a risk" })],
        incompleteChecks: [
          { id: "sprite.unreadable", category: "sprite", message: "could not read the sprite" }
        ]
      })
    );

    const lines = output.trimEnd().split("\n");
    expect(lines.at(-2)).toContain("a risk");
    expect(lines.at(-1)).toContain("incomplete could not read the sprite");
  });

  it("reports the summary counts", () => {
    const output = formatPretty(
      report({
        findings: [
          finding({ severity: "broken" }),
          finding({ severity: "broken" }),
          finding({ severity: "risky" })
        ]
      })
    );

    expect(output).toContain("Broken 2, risky 1, warnings 0, incomplete 0");
  });

  it("ends with exactly one newline", () => {
    const output = formatPretty(report());

    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });
});

describe("formatGithubAnnotations", () => {
  // `info` is weak evidence by design — a name a partial sample did not supply.
  // Emitting it as a warning floods the annotation list and overstates the
  // report, while SARIF and VS Code already map it to note and information.
  it.each([
    ["broken", "error"],
    ["risky", "warning"],
    ["warning", "warning"],
    ["info", "notice"]
  ] as const)("annotates a %s finding as %s", (severity, command) => {
    const output = formatGithubAnnotations(report({ findings: [finding({ severity })] }));

    expect(output).toBe(`::${command} title=source-layer::something happened`);
  });

  it("annotates incomplete checks as notices", () => {
    const output = formatGithubAnnotations(
      report({
        incompleteChecks: [{ id: "glyph.unreachable", category: "glyph", message: "no glyphs" }]
      })
    );

    expect(output).toBe("::notice title=glyph::no glyphs");
  });

  // A workflow command ends at the newline, so an unescaped multi-line message
  // truncates the annotation and spills the rest into the log as bare text. A
  // literal `%` would also swallow whatever followed it as an escape.
  it("escapes the characters that would break a workflow command", () => {
    const output = formatGithubAnnotations(
      report({
        findings: [
          finding({ severity: "broken", message: "line one\r\nline two 100% broken" })
        ]
      })
    );

    expect(output).toBe("::error title=source-layer::line one%0D%0Aline two 100%25 broken");
    expect(output).not.toContain("\n");
  });

  it("escapes the percent sign before the characters it encodes", () => {
    const output = formatGithubAnnotations(
      report({ findings: [finding({ severity: "broken", message: "%0A" })] })
    );

    // Ordering matters: escaping the newline first would leave a literal `%0A`
    // indistinguishable from an encoded one.
    expect(output).toBe("::error title=source-layer::%250A");
  });

  it("returns an empty string for a clean report", () => {
    expect(formatGithubAnnotations(report())).toBe("");
  });
});
