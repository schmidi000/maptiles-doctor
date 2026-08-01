import chalk from "chalk";
import type { DoctorReport, Severity } from "@maptiles-doctor/core";

export function formatPretty(report: DoctorReport): string {
  const lines = [
    `${statusLabel(report.status)} MapTiles Doctor: ${report.status}`,
    `Broken ${report.summary.broken}, risky ${report.summary.risky}, warnings ${report.summary.warning}, incomplete ${report.summary.incomplete}`
  ];

  for (const finding of report.findings) {
    lines.push(
      `${severityLabel(finding.severity)} ${finding.message}${finding.suggestion ? ` Suggestion: ${finding.suggestion}.` : ""}`
    );
  }

  for (const check of report.incompleteChecks) {
    lines.push(`${chalk.yellow("incomplete")} ${check.message}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatGithubAnnotations(report: DoctorReport): string {
  return [
    ...report.findings.map((finding) => {
      const command = githubAnnotationCommand(finding.severity);
      return `::${command} title=${escapeAnnotation(finding.category)}::${escapeAnnotation(finding.message)}`;
    }),
    ...report.incompleteChecks.map(
      (check) =>
        `::notice title=${escapeAnnotation(check.category)}::${escapeAnnotation(check.message)}`
    )
  ].join("\n");
}

/**
 * `info` is the severity this tool uses deliberately for weak evidence — a name
 * a partial tile sample did not happen to supply. Emitting it as a workflow
 * warning both floods the annotation list and overstates the report: SARIF and
 * VS Code already map `info` to note and information, and GitHub has a notice
 * annotation that means exactly that.
 */
function githubAnnotationCommand(severity: Severity): "error" | "warning" | "notice" {
  if (severity === "broken") {
    return "error";
  }
  return severity === "info" ? "notice" : "warning";
}

function statusLabel(status: DoctorReport["status"]): string {
  if (status === "failed") {
    return chalk.red("✖");
  }
  if (status === "incomplete") {
    return chalk.yellow("!");
  }
  return chalk.green("✓");
}

function severityLabel(severity: Severity): string {
  if (severity === "broken") {
    return chalk.red("broken");
  }
  if (severity === "risky") {
    return chalk.yellow("risky");
  }
  if (severity === "warning") {
    return chalk.yellow("warning");
  }
  return chalk.blue("info");
}

function escapeAnnotation(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
