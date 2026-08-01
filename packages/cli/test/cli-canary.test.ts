import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DoctorCheckOptions, DoctorReport } from "@maptiles-doctor/core";

// The CLI's job for canaries is to assemble them from flags and a file; whether
// a browser then renders anything is core's contract, tested there. Mocking the
// engine keeps this suite from launching Chromium for a flag-parsing check.
const checkStyleContract = vi.fn<(options: DoctorCheckOptions) => Promise<DoctorReport>>();

vi.mock("@maptiles-doctor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@maptiles-doctor/core")>()),
  checkStyleContract: (options: DoctorCheckOptions) => checkStyleContract(options)
}));

const { run } = await import("../src/index.js");

const passingStyle = resolve(import.meta.dirname, "../../../fixtures/simple-style/style.json");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-canary-cli-"));
});

afterEach(() => {
  process.exitCode = undefined;
  checkStyleContract.mockReset();
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function check(args: string[]): Promise<number> {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await run(["node", "maptiles-doctor", "check", ...args]);
  } finally {
    stdout.mockRestore();
  }
}

describe("CLI canary flags", () => {
  it("collects canaries from repeated --canary flags and a --canaries file", async () => {
    checkStyleContract.mockResolvedValue(passedReport());
    const canaryFile = join(workDir, "canaries.json");
    await writeFile(
      canaryFile,
      JSON.stringify([{ id: "from-file", center: [1, 2], zoom: 4, expectLayers: ["poi-dots"] }])
    );

    const code = await check([
      passingStyle,
      "--canary",
      "13.4,52.5,14,berlin",
      "--canary",
      "0,0,2",
      "--canaries",
      canaryFile,
      "--screenshot-dir",
      workDir,
      "--baseline-dir",
      workDir,
      "--max-diff-ratio",
      "0.01",
      "--format",
      "json"
    ]);

    expect(code).toBe(0);
    expect(checkStyleContract.mock.calls[0]?.[0]).toMatchObject({
      screenshotDir: workDir,
      baselineDir: workDir,
      maxDiffRatio: 0.01,
      canaries: [
        { id: "berlin", center: [13.4, 52.5], zoom: 14 },
        // An id is derived from the view when the flag omits one, so a report
        // stays readable and a baseline file keeps a stable name.
        { id: "0-0-z2", center: [0, 0], zoom: 2 },
        { id: "from-file", center: [1, 2], zoom: 4, expectLayers: ["poi-dots"] }
      ]
    });
  });

  it("passes no canaries when none are requested", async () => {
    checkStyleContract.mockResolvedValue(passedReport());

    await check([passingStyle, "--format", "json"]);

    expect(checkStyleContract.mock.calls[0]?.[0].canaries).toEqual([]);
  });

  it("returns exit code 2 for a malformed canary or diff ratio", async () => {
    checkStyleContract.mockResolvedValue(passedReport());
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await check([passingStyle, "--canary", "13.4,52.5"])).toBe(2);
      process.exitCode = undefined;
      expect(await check([passingStyle, "--canary", "here,there,14"])).toBe(2);
      process.exitCode = undefined;
      expect(await check([passingStyle, "--max-diff-ratio", "2"])).toBe(2);
      process.exitCode = undefined;
      expect(await check([passingStyle, "--canaries", join(workDir, "missing.json")])).toBe(2);
    } finally {
      stderr.mockRestore();
    }
    expect(checkStyleContract).not.toHaveBeenCalled();
  });
});

function passedReport(): DoctorReport {
  return {
    schemaVersion: "1.0",
    status: "passed",
    generatedAt: "2026-07-31T00:00:00.000Z",
    artifactHashes: {},
    checks: [],
    findings: [],
    incompleteChecks: [],
    summary: { broken: 0, risky: 0, warning: 0, info: 0, incomplete: 0 }
  };
}
