#!/usr/bin/env node
// Runs the built CLI against real production styles and reports what it found.
//
// This is an observation harness, not a gate. It always exits 0 unless the
// harness itself broke, because a finding against a live third-party style is a
// question ("is this real?"), not a failure. Turning it into a pass/fail check
// before the false-positive rate is known would only teach us to ignore it.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const cacheDir = join(here, ".cache");
const reportDir = join(here, "reports");
const cli = join(repoRoot, "packages", "cli", "dist", "index.js");

const args = process.argv.slice(2);
const only = valueOf("--only");
const refresh = args.includes("--refresh");
const offline = args.includes("--offline");
const timeoutMs = Number(valueOf("--timeout-ms") ?? 30_000);

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

if (!existsSync(cli)) {
  console.error(`Built CLI not found at ${cli}. Run: npm run build`);
  process.exit(2);
}

const corpus = JSON.parse(await readFile(join(here, "corpus.json"), "utf8"));
const targets = corpus.targets.filter((t) => !only || t.id === only);
if (targets.length === 0) {
  console.error(only ? `No target with id ${only}` : "Corpus is empty");
  process.exit(2);
}

await mkdir(cacheDir, { recursive: true });
await mkdir(reportDir, { recursive: true });

const results = [];
for (const target of targets) {
  process.stdout.write(`\n=== ${target.id} (${target.schema}) ===\n`);
  let result;
  try {
    const stylePath = await cacheStyle(target);
    result = await checkStyle(target, stylePath);
  } catch (error) {
    // A target that cannot be fetched or checked is a harness observation too,
    // but it must not look like a clean run.
    result = { id: target.id, harnessError: String(error.message ?? error) };
    console.log(`  harness error: ${result.harnessError}`);
  }
  results.push(result);
}

printSummary(results);
await writeFile(join(reportDir, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nReports written to ${reportDir}`);

/** Styles are cached so a run is repeatable and so seeded-failure work later can mutate a stable copy. */
async function cacheStyle(target) {
  const dir = join(cacheDir, target.id);
  await mkdir(dir, { recursive: true });
  const stylePath = join(dir, "style.json");
  if (existsSync(stylePath) && !refresh) {
    console.log("  style: cached");
    return stylePath;
  }
  const text = await fetchWithRetry(target.style);
  JSON.parse(text); // Fail here rather than inside the checker if the provider served HTML.
  await writeFile(stylePath, text);
  console.log(`  style: fetched ${text.length} bytes`);
  return stylePath;
}

/**
 * Third-party endpoints drop connections. A transient failure here says nothing
 * about the checker, so retry rather than report a target the harness never ran.
 */
async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.log(`  style: attempt ${attempt} failed (${error.message}), retrying`);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw new Error(`fetching style after ${attempts} attempts: ${lastError.message}`);
}

async function checkStyle(target, stylePath) {
  const reportPath = join(reportDir, `${target.id}.json`);
  const argv = [
    cli,
    "check",
    stylePath,
    "--format",
    "json",
    "--output",
    reportPath,
    "--timeout-ms",
    String(timeoutMs),
    ...(offline ? ["--offline"] : []),
    ...(target.sources ?? []).flatMap((s) => ["--source", s])
  ];

  const startedAt = process.hrtime.bigint();
  let exitCode = 0;
  try {
    // The CLI exits 1 on contract findings, which is a result, not an error.
    await execFileAsync(process.execPath, argv, { cwd: repoRoot, timeout: timeoutMs * 6 });
  } catch (error) {
    if (typeof error.code === "number") {
      exitCode = error.code;
    } else {
      throw new Error(`CLI did not complete: ${error.message}`, { cause: error });
    }
    if (exitCode === 2) {
      throw new Error(`CLI reported an invalid invocation or runtime error:\n${error.stderr}`, {
        cause: error
      });
    }
  }
  const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const byCategory = {};
  for (const finding of report.findings) {
    const key = `${finding.category}/${finding.severity}`;
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }

  console.log(`  status: ${report.status}  exit: ${exitCode}  ${durationMs}ms`);
  console.log(
    `  findings: ${report.findings.length}  incomplete: ${report.incompleteChecks.length}`
  );
  for (const [key, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key}: ${count}`);
  }
  for (const incomplete of report.incompleteChecks) {
    console.log(`    incomplete ${incomplete.category}: ${incomplete.message}`);
  }
  // Findings are what need triage, so show enough of each to judge it.
  for (const finding of report.findings.slice(0, 12)) {
    const where = [finding.layerId, finding.sourceLayer, finding.property]
      .filter(Boolean)
      .join(" / ");
    console.log(`    [${finding.severity}] ${finding.message}${where ? `  (${where})` : ""}`);
  }
  if (report.findings.length > 12) {
    console.log(`    … ${report.findings.length - 12} more in ${target.id}.json`);
  }

  return {
    id: target.id,
    schema: target.schema,
    status: report.status,
    exitCode,
    durationMs,
    counts: report.summary,
    findingCount: report.findings.length,
    incompleteCount: report.incompleteChecks.length,
    byCategory
  };
}

function printSummary(rows) {
  console.log(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
  const header = ["target", "status", "broken", "risky", "warn", "info", "incompl", "ms"];
  const width = (i) => (i === 0 ? 24 : i === 1 ? 12 : 8);
  console.log(header.map((h, i) => h.padEnd(width(i))).join(""));
  for (const row of rows) {
    if (row.harnessError) {
      console.log(`${row.id.padEnd(24)}HARNESS ERROR: ${row.harnessError}`);
      continue;
    }
    const cells = [
      row.id.padEnd(24),
      String(row.status).padEnd(12),
      String(row.counts.broken).padEnd(8),
      String(row.counts.risky).padEnd(8),
      String(row.counts.warning).padEnd(8),
      String(row.counts.info).padEnd(8),
      String(row.counts.incomplete).padEnd(8),
      String(row.durationMs)
    ];
    console.log(cells.join(""));
  }
  console.log(
    "\nEvery non-zero count above needs a verdict: real contract break, or checker false positive."
  );
}
