import type { DoctorReport, Finding } from "@maptiles-doctor/core";

export function renderHtmlReport(report: DoctorReport): string {
  const rows = report.findings.map(renderFindingRow).join("");
  const incompleteRows = report.incompleteChecks
    .map(
      (check) =>
        `<tr><td>incomplete</td><td>${escapeHtml(check.category)}</td><td>${escapeHtml(
          check.message
        )}</td><td>${escapeHtml(check.path ?? "")}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MapTiles Doctor Report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #f4f4f4; }
    .status-failed { color: #a40000; }
    .status-incomplete { color: #8a5a00; }
    .status-passed { color: #126b2f; }
  </style>
</head>
<body>
  <h1>MapTiles Doctor Report</h1>
  <p class="status-${report.status}">Status: ${escapeHtml(report.status)}</p>
  <p>Generated: ${escapeHtml(report.generatedAt)}</p>
  <h2>Summary</h2>
  <ul>
    <li>Broken: ${report.summary.broken}</li>
    <li>Risky: ${report.summary.risky}</li>
    <li>Warnings: ${report.summary.warning}</li>
    <li>Info: ${report.summary.info}</li>
    <li>Incomplete: ${report.summary.incomplete}</li>
  </ul>
  <h2>Findings</h2>
  <table>
    <thead><tr><th>Severity</th><th>Category</th><th>Message</th><th>Path</th></tr></thead>
    <tbody>${rows}${incompleteRows}</tbody>
  </table>
</body>
</html>`;
}

export function renderSarif(report: DoctorReport): string {
  return JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "MapTiles Doctor",
              informationUri: "https://maptiles-doctor.com",
              rules: Array.from(new Set(report.findings.map((finding) => finding.id))).map(
                (id) => ({
                  id,
                  shortDescription: { text: id }
                })
              )
            }
          },
          results: report.findings.map((finding) => ({
            ruleId: finding.id,
            level: sarifLevel(finding.severity),
            message: { text: finding.message },
            locations: finding.path
              ? [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.path }
                    }
                  }
                ]
              : []
          }))
        }
      ]
    },
    null,
    2
  );
}

function renderFindingRow(finding: Finding): string {
  return `<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(
    finding.category
  )}</td><td>${escapeHtml(finding.message)}</td><td>${escapeHtml(finding.path ?? "")}</td></tr>`;
}

function sarifLevel(severity: Finding["severity"]): "error" | "warning" | "note" {
  if (severity === "broken") {
    return "error";
  }
  if (severity === "risky" || severity === "warning") {
    return "warning";
  }
  return "note";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
