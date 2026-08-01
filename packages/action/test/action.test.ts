import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

const inputs = new Map<string, string>();
const calls = {
  error: [] as string[],
  warning: [] as string[],
  notice: [] as string[],
  outputs: new Map<string, string>(),
  failed: [] as string[]
};

vi.mock("@actions/core", () => ({
  getInput: (name: string, options?: { required?: boolean }) => {
    const value = inputs.get(name) ?? "";
    if (!value && options?.required) {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return value;
  },
  setOutput: (name: string, value: string) => calls.outputs.set(name, value),
  error: (message: string) => calls.error.push(message),
  warning: (message: string) => calls.warning.push(message),
  notice: (message: string) => calls.notice.push(message),
  setFailed: (message: string) => calls.failed.push(message)
}));

const { runAction } = await import("../src/index.js");

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-action-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  inputs.clear();
  calls.error.length = 0;
  calls.warning.length = 0;
  calls.notice.length = 0;
  calls.failed.length = 0;
  calls.outputs.clear();
});

describe("runAction", () => {
  it("writes the report, annotates findings, and fails the job on broken contracts", async () => {
    const reportPath = join(workDir, "broken-report.json");
    inputs.set("style", resolve(root, "fixtures/broken-style/style.json"));
    inputs.set("sources", `openmaptiles=${tilejson}`);
    inputs.set("report", reportPath);

    await runAction();

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.status).toBe("failed");
    expect(calls.outputs.get("report")).toBe(reportPath);
    expect(calls.error.some((message) => message.startsWith("source-layer:"))).toBe(true);
    expect(calls.warning.some((message) => message.startsWith("expression-property:"))).toBe(true);
    expect(calls.failed).toHaveLength(1);
  });

  it("does not fail the job for a passing style", async () => {
    const reportPath = join(workDir, "passing-report.json");
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", `openmaptiles=${tilejson}`);
    inputs.set("report", reportPath);

    await runAction();

    expect(JSON.parse(await readFile(reportPath, "utf8")).status).toBe("passed");
    expect(calls.failed).toHaveLength(0);
    expect(calls.error).toHaveLength(0);
  });

  it("emits notices for incomplete checks without failing the job", async () => {
    const reportPath = join(workDir, "incomplete-report.json");
    inputs.set("style", resolve(root, "fixtures/missing-sprite/style.json"));
    inputs.set("report", reportPath);

    await runAction();

    expect(calls.notice).toEqual([expect.stringContaining("sprite:")]);
    expect(calls.failed).toHaveLength(0);
  });

  it("honors a lowered fail threshold", async () => {
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", `ghost=${tilejson}`);
    inputs.set("report", join(workDir, "threshold-report.json"));
    inputs.set("fail-threshold", "warning");

    await runAction();

    expect(calls.failed).toHaveLength(1);
  });

  it("defaults the report path when none is supplied", async () => {
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", `openmaptiles=${tilejson}`);
    const previousCwd = process.cwd();
    process.chdir(workDir);

    try {
      await runAction();
      expect(calls.outputs.get("report")).toBe("maptiles-doctor-report.json");
      expect(
        JSON.parse(await readFile(join(workDir, "maptiles-doctor-report.json"), "utf8")).status
      ).toBe("passed");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("reports remote artifacts as incomplete when offline is set", async () => {
    const reportPath = join(workDir, "offline-report.json");
    inputs.set("style", resolve(root, "fixtures/remote-source/style.json"));
    inputs.set("report", reportPath);
    inputs.set("offline", "true");

    await runAction();

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.incompleteChecks[0].id).toBe("source.openmaptiles.network-disabled");
    expect(calls.failed).toHaveLength(0);
  });

  it("checks declared metadata only when tile sampling is skipped", async () => {
    const reportPath = join(workDir, "no-sampling-report.json");
    inputs.set("style", resolve(root, "fixtures/stale-metadata/style.json"));
    inputs.set("report", reportPath);
    inputs.set("skip-tile-sampling", "true");

    await runAction();

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.findings).toHaveLength(0);
    expect(report.checks.find((check: { id: string }) => check.id === "tile-sample").status).toBe(
      "incomplete"
    );
  });

  it("samples tiles by default", async () => {
    const reportPath = join(workDir, "sampling-report.json");
    inputs.set("style", resolve(root, "fixtures/stale-metadata/style.json"));
    inputs.set("report", reportPath);

    await runAction();

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.findings[0].id).toBe("layer.buildings-by-class.property.class.not-sampled");
    // Sampled absence is `info` by design, so it annotates as a notice. Emitting
    // it as a warning overstated weak evidence and buried the real warnings.
    expect(report.findings[0].severity).toBe("info");
    expect(calls.notice[0]).toContain("expression-property:");
    expect(calls.warning).toHaveLength(0);
  });

  // An unrecognized threshold used to be cast straight through. Every severity
  // comparison against it came out false, so a typo in a workflow file turned
  // the whole gate off and the job passed with a report full of findings.
  it("rejects an unrecognized fail threshold instead of disabling the gate", async () => {
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", `ghost=${tilejson}`);
    inputs.set("report", join(workDir, "invalid-threshold-report.json"));
    inputs.set("fail-threshold", "warnin");

    await expect(runAction()).rejects.toThrow(
      'Invalid fail-threshold "warnin". Expected one of: info, warning, risky, broken.'
    );
  });

  it("counts findings at the configured threshold, not broken ones", async () => {
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", `ghost=${tilejson}`);
    inputs.set("report", join(workDir, "threshold-count-report.json"));
    inputs.set("fail-threshold", "warning");

    await runAction();

    // The only finding is a `warning`, so reporting the `broken` count here
    // announced "found 0 issue(s)" on a job it had just failed.
    expect(calls.failed).toEqual(["MapTiles Doctor found 1 contract issue(s) at or above warning."]);
  });

  it("rejects a malformed source override", async () => {
    inputs.set("style", resolve(root, "fixtures/simple-style/style.json"));
    inputs.set("sources", "openmaptiles");

    await expect(runAction()).rejects.toThrow("Invalid source override: openmaptiles");
  });

  it("rejects when the required style input is missing", async () => {
    await expect(runAction()).rejects.toThrow(/style/);
  });
});
