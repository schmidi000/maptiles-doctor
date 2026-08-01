#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  checkStyleContract,
  doctorReportJsonSchema,
  type CanarySpec,
  type DoctorSourceInput,
  type Severity,
  severityRank
} from "@maptiles-doctor/core";
import { renderHtmlReport, renderSarif } from "@maptiles-doctor/report";
import { formatGithubAnnotations, formatPretty } from "./format.js";

export async function run(argv = process.argv): Promise<number> {
  const program = new Command();
  // Commander exits the process with code 1 on a usage error by default; the
  // documented contract is exit code 2 for an invalid invocation.
  program
    .exitOverride()
    .name("maptiles-doctor")
    .description("Validate MapLibre/Mapbox style contracts against actual tile artifacts.")
    .version("0.1.0");

  program
    .command("check")
    .argument("<style>", "Path or URL to style JSON")
    .option("-s, --source <id=path>", "Source override. Repeatable.", collectSource, [])
    .option("-f, --format <format>", "Output format: pretty, json, sarif, github, html", "pretty")
    .option("-o, --output <path>", "Write output to file instead of stdout")
    .option("--fail-threshold <severity>", "info, warning, risky, broken", parseSeverity, "broken")
    .option("--timeout-ms <ms>", "Network timeout in milliseconds", parsePositiveInteger, 10_000)
    .option("--offline", "Report remote artifacts as incomplete instead of fetching them", false)
    .option("--no-sample-tiles", "Check declared metadata only, without reading tiles")
    .option(
      "--max-sample-tiles <count>",
      "Tile addresses to probe per source",
      parsePositiveInteger,
      3
    )
    .option(
      "--sample-at <lon,lat>",
      "Sample tiles at this location instead of the built-in populated anchors",
      parseLonLat
    )
    .option(
      "--sampled-absence <severity>",
      "Severity when only a partial sample says something is absent: info, warning, risky",
      parseAbsenceSeverity,
      "info"
    )
    .option(
      "--canary <lon,lat,zoom[,id]>",
      "Render a view with MapLibre GL in a headless browser. Repeatable.",
      collectCanary,
      []
    )
    .option("--canaries <path>", "JSON file with an array of canary definitions")
    .option("--screenshot-dir <dir>", "Directory to write canary screenshots and diffs to")
    .option("--baseline-dir <dir>", "Directory of <canary-id>.png baselines to compare against")
    .option(
      "--max-diff-ratio <ratio>",
      "Fraction of differing pixels tolerated against a baseline",
      parseRatio,
      0.005
    )
    .action(async (style: string, options: CheckCommandOptions) => {
      const canaries = [...options.canary, ...(await readCanaryFile(options.canaries))];
      const report = await checkStyleContract({
        stylePath: style,
        sources: options.source,
        failThreshold: options.failThreshold,
        timeoutMs: options.timeoutMs,
        allowNetwork: !options.offline,
        sampleTiles: options.sampleTiles,
        maxSampleTiles: options.maxSampleTiles,
        ...(options.sampleAt === undefined ? {} : { sampleAt: options.sampleAt }),
        sampledAbsenceSeverity: options.sampledAbsence,
        canaries,
        maxDiffRatio: options.maxDiffRatio,
        ...(options.screenshotDir === undefined ? {} : { screenshotDir: options.screenshotDir }),
        ...(options.baselineDir === undefined ? {} : { baselineDir: options.baselineDir })
      });

      const rendered = renderReport(report, options.format);
      if (options.output) {
        await writeFile(options.output, rendered);
      } else {
        process.stdout.write(rendered);
        if (!rendered.endsWith("\n")) {
          process.stdout.write("\n");
        }
      }

      process.exitCode = report.status === "failed" ? 1 : 0;
    });

  program
    .command("schema")
    .description("Print the JSON Schema for the report format")
    .option("-o, --output <path>", "Write the schema to a file instead of stdout")
    .action(async (options: { output?: string }) => {
      const schema = `${JSON.stringify(doctorReportJsonSchema(), null, 2)}\n`;
      if (options.output) {
        await writeFile(options.output, schema);
      } else {
        process.stdout.write(schema);
      }
      process.exitCode = 0;
    });

  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` throw too, but they are successful runs and
      // commander has already written its own message.
      return error.exitCode === 0 ? 0 : 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

interface CheckCommandOptions {
  source: DoctorSourceInput[];
  format: string;
  output?: string;
  failThreshold: Severity;
  timeoutMs: number;
  offline: boolean;
  sampleTiles: boolean;
  maxSampleTiles: number;
  sampleAt?: [number, number];
  sampledAbsence: "info" | "warning" | "risky";
  canary: CanarySpec[];
  canaries?: string;
  screenshotDir?: string;
  baselineDir?: string;
  maxDiffRatio: number;
}

/** `lon,lat,zoom` with an optional trailing id, e.g. `13.4,52.5,14,berlin`. */
function collectCanary(value: string, previous: CanarySpec[]): CanarySpec[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length < 3 || parts.length > 4) {
    throw new InvalidArgumentError("Expected --canary lon,lat,zoom[,id]");
  }

  const [lon, lat, zoom] = parts.slice(0, 3).map(Number);
  if (![lon, lat, zoom].every((part) => Number.isFinite(part))) {
    throw new InvalidArgumentError("Expected --canary lon,lat,zoom to be numbers");
  }

  return [
    ...previous,
    {
      id: parts[3] || `${lon}-${lat}-z${zoom}`,
      center: [lon!, lat!],
      zoom: zoom!
    }
  ];
}

async function readCanaryFile(path: string | undefined): Promise<CanarySpec[]> {
  if (!path) {
    return [];
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new InvalidArgumentError(`Expected ${path} to contain an array of canary definitions`);
  }
  return parsed as CanarySpec[];
}

/**
 * `broken` is deliberately not accepted. A sample that did not contain something
 * is not proof that it is missing, so no flag should be able to turn absence
 * into a build failure on its own.
 */
function parseAbsenceSeverity(value: string): "info" | "warning" | "risky" {
  if (value === "info" || value === "warning" || value === "risky") {
    return value;
  }
  if (value === "broken") {
    throw new InvalidArgumentError(
      "Absence from a partial sample cannot prove a break; use info, warning, or risky"
    );
  }
  throw new InvalidArgumentError("Expected severity: info, warning, risky");
}

function parseLonLat(value: string): [number, number] {
  const parts = value.split(",").map((part) => Number(part.trim()));
  const [lon, lat] = parts;
  if (
    parts.length !== 2 ||
    lon === undefined ||
    lat === undefined ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new InvalidArgumentError("Expected --sample-at lon,lat within -180,-90 to 180,90");
  }
  return [lon, lat];
}

function parseRatio(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("Expected a ratio between 0 and 1");
  }
  return parsed;
}

function renderReport(
  report: Awaited<ReturnType<typeof checkStyleContract>>,
  format: string
): string {
  if (format === "pretty") {
    return formatPretty(report);
  }
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (format === "sarif") {
    return renderSarif(report);
  }
  if (format === "github") {
    return formatGithubAnnotations(report);
  }
  if (format === "html") {
    return renderHtmlReport(report);
  }
  throw new InvalidArgumentError(`Unknown format ${format}`);
}

function collectSource(value: string, previous: DoctorSourceInput[]): DoctorSourceInput[] {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new InvalidArgumentError("Expected --source id=path-or-url");
  }
  return [
    ...previous,
    {
      id: value.slice(0, separatorIndex),
      location: value.slice(separatorIndex + 1)
    }
  ];
}

function parseSeverity(value: string): Severity {
  if (value in severityRank) {
    return value as Severity;
  }
  throw new InvalidArgumentError("Expected severity: info, warning, risky, broken");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv);
}
