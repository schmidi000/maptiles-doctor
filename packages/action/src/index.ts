import { writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import {
  checkStyleContract,
  severityRank,
  type DoctorSourceInput,
  type Severity
} from "@maptiles-doctor/core";

export async function runAction(): Promise<void> {
  const style = core.getInput("style", { required: true });
  const sources = parseSources(core.getInput("sources"));
  const failThreshold = parseSeverity(core.getInput("fail-threshold"));
  const reportPath = core.getInput("report") || "maptiles-doctor-report.json";

  const report = await checkStyleContract({
    stylePath: style,
    sources,
    failThreshold,
    allowNetwork: !isTrue(core.getInput("offline")),
    sampleTiles: !isTrue(core.getInput("skip-tile-sampling"))
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  core.setOutput("report", reportPath);

  for (const finding of report.findings) {
    const message = `${finding.category}: ${finding.message}`;
    if (finding.severity === "broken") {
      core.error(message);
    } else {
      core.warning(message);
    }
  }

  for (const incomplete of report.incompleteChecks) {
    core.notice(`${incomplete.category}: ${incomplete.message}`);
  }

  if (report.status === "failed") {
    // Counting `broken` regardless of the threshold announced "found 0 broken
    // contract issue(s)" on a job that failed on risky findings.
    const failing = report.findings.filter(
      (finding) => severityRank[finding.severity] >= severityRank[failThreshold]
    ).length;
    core.setFailed(
      `MapTiles Doctor found ${failing} contract issue(s) at or above ${failThreshold}.`
    );
  }
}

function isTrue(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/**
 * An unrecognized threshold used to be cast through unchecked. Every severity
 * comparison against it comes out false, so `fail-threshold: brokn` silently
 * turned the whole gate off and the job passed with a report full of findings.
 */
function parseSeverity(value: string): Severity {
  const normalized = value.trim() || "broken";
  if (Object.hasOwn(severityRank, normalized)) {
    return normalized as Severity;
  }
  throw new Error(
    `Invalid fail-threshold "${value}". Expected one of: ${Object.keys(severityRank).join(", ")}.`
  );
}

function parseSources(value: string): DoctorSourceInput[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === line.length - 1) {
        throw new Error(`Invalid source override: ${line}`);
      }
      return {
        id: line.slice(0, separatorIndex),
        location: line.slice(separatorIndex + 1)
      };
    });
}
