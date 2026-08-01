import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const bundleSource = resolve(root, "packages/action/action-dist/index.cjs");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

/**
 * A runner checks out the repository and executes the bundle with no npm
 * install, so these cases copy it outside the workspace: nothing up the
 * directory tree resolves, which is exactly the runner's module resolution.
 */
let workDir: string;
let bundle: string;

async function runBundle(
  inputs: Record<string, string>
): Promise<{ code: number; stdout: string; outputs: string }> {
  const outputFile = join(workDir, `github-output-${Object.keys(inputs).length}-${inputs.report}`);
  await writeFile(outputFile, "");

  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile };
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`] = value;
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, [bundle], { cwd: workDir, env });
    return { code: 0, stdout, outputs: await readFile(outputFile, "utf8") };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      outputs: await readFile(outputFile, "utf8")
    };
  }
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-bundle-"));
  bundle = join(workDir, "index.cjs");
  await copyFile(bundleSource, bundle);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("bundled GitHub Action", () => {
  it("runs standalone, writes the report, and fails the job on broken contracts", async () => {
    const { code, stdout, outputs } = await runBundle({
      style: resolve(root, "fixtures/broken-style/style.json"),
      sources: `openmaptiles=${tilejson}`,
      report: "report.json"
    });

    expect(code).toBe(1);
    expect(stdout).toContain("::error::source-layer: Layer 3d-buildings references missing");
    expect(stdout).toContain("::warning::expression-property:");
    expect(outputs).toContain("report.json");

    const report = JSON.parse(await readFile(join(workDir, "report.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.summary.broken).toBe(2);
  });

  it("succeeds for a passing style", async () => {
    const { code, stdout } = await runBundle({
      style: resolve(root, "fixtures/simple-style/style.json"),
      sources: `openmaptiles=${tilejson}`,
      report: "passing.json"
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("::error::");
  });

  it("degrades to an incomplete check when the native MBTiles module is unavailable", async () => {
    const { code, stdout } = await runBundle({
      style: resolve(root, "fixtures/mbtiles-style/style.json"),
      report: "mbtiles.json"
    });

    // Nothing in the bundle's tree resolves better-sqlite3, so MBTiles reads
    // must report incomplete rather than crash or silently pass.
    expect(code).toBe(0);
    expect(stdout).toContain("::notice::source: Could not read source basemap");
    const report = JSON.parse(await readFile(join(workDir, "mbtiles.json"), "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks[0].message).toContain("better-sqlite3");
  });

  it("fails the job cleanly when an input is malformed", async () => {
    const { code, stdout } = await runBundle({
      style: resolve(root, "fixtures/simple-style/style.json"),
      sources: "openmaptiles",
      report: "invalid.json"
    });

    expect(code).toBe(1);
    expect(stdout).toContain("::error::Invalid source override: openmaptiles");
  });
});
