import { writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import { checkStyleContract, type DoctorSourceInput, type Severity } from "@maptiles-doctor/core";

export async function runAction(): Promise<void> {
  const style = core.getInput("style", { required: true });
  const sources = parseSources(core.getInput("sources"));
  const failThreshold = (core.getInput("fail-threshold") || "broken") as Severity;
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
    core.setFailed(`MapTiles Doctor found ${report.summary.broken} broken contract issue(s).`);
  }
}

function isTrue(value: string): boolean {
  return value.trim().toLowerCase() === "true";
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
