import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { guardBrokenPipe, run } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const brokenStyle = resolve(root, "fixtures/broken-style/style.json");
const passingStyle = resolve(root, "fixtures/simple-style/style.json");
const tilejson = resolve(root, "fixtures/simple-style/tilejson.json");

let workDir: string;

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

/** Commander writes option errors to stderr; silence it and keep the text. */
function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

async function check(args: string[]): Promise<{ code: number; stdout: string }> {
  const stdout = captureStdout();
  try {
    const code = await run(["node", "maptiles-doctor", "check", ...args]);
    return { code, stdout: stdout.chunks.join("") };
  } finally {
    stdout.restore();
  }
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-cli-"));
});

afterEach(() => {
  // `run` sets process.exitCode so the bin exits correctly; clear it so one
  // case cannot leak its exit code into the next.
  process.exitCode = undefined;
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("CLI", () => {
  it("returns exit code 1 for broken contracts", async () => {
    const { code, stdout } = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "json"
    ]);

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: "1.0", status: "failed" });
  });

  it("returns exit code 0 for a passing style", async () => {
    const { code, stdout } = await check([
      passingStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "json"
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).status).toBe("passed");
  });

  it("returns exit code 0 for an incomplete run at the default threshold", async () => {
    const { code, stdout } = await check([
      resolve(root, "fixtures/missing-sprite/style.json"),
      "--format",
      "json"
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).status).toBe("incomplete");
  });

  it("fails a risky-only style when the threshold is lowered", async () => {
    const passing = await check([
      passingStyle,
      "--source",
      `ghost=${tilejson}`,
      "--format",
      "json"
    ]);
    expect(passing.code).toBe(0);
    process.exitCode = undefined;

    const strict = await check([
      passingStyle,
      "--source",
      `ghost=${tilejson}`,
      "--fail-threshold",
      "warning",
      "--format",
      "json"
    ]);

    expect(strict.code).toBe(1);
  });

  it("renders pretty output by default", async () => {
    const { stdout } = await check([passingStyle, "--source", `openmaptiles=${tilejson}`]);

    expect(stdout).toContain("MapTiles Doctor: passed");
    expect(stdout.endsWith("\n")).toBe(true);
  });

  it("renders GitHub workflow annotations", async () => {
    const { stdout } = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "github"
    ]);

    expect(stdout).toContain("::error title=source-layer::");
    expect(stdout).toContain("::warning title=expression-property::");
  });

  it("renders SARIF and HTML", async () => {
    const sarif = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "sarif"
    ]);
    expect(JSON.parse(sarif.stdout).version).toBe("2.1.0");
    process.exitCode = undefined;

    const html = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "html"
    ]);
    expect(html.stdout).toContain("<!doctype html>");
  });

  it("writes the report to a file instead of stdout with --output", async () => {
    const output = join(workDir, "report.json");
    const { code, stdout } = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "json",
      "--output",
      output
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(await readFile(output, "utf8")).status).toBe("failed");
  });

  it("checks declared metadata only with --no-sample-tiles", async () => {
    const { code, stdout } = await check([
      resolve(root, "fixtures/stale-metadata/style.json"),
      "--no-sample-tiles",
      "--format",
      "json"
    ]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.findings).toHaveLength(0);
    expect(report.checks.find((check: { id: string }) => check.id === "tile-sample").status).toBe(
      "incomplete"
    );
  });

  it("reports remote artifacts as incomplete with --offline", async () => {
    const { code, stdout } = await check([
      resolve(root, "fixtures/remote-source/style.json"),
      "--offline",
      "--format",
      "json"
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).incompleteChecks[0].id).toBe("source.openmaptiles.network-disabled");
  });

  it("limits probed tile addresses with --max-sample-tiles", async () => {
    const { stdout } = await check([
      resolve(root, "fixtures/empty-tiles/style.json"),
      "--max-sample-tiles",
      "1",
      "--format",
      "json"
    ]);

    expect(JSON.parse(stdout).findings[0].evidence.attempted).toEqual(["0/0/0"]);
  });

  it("returns exit code 2 for a non-positive --max-sample-tiles", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { code } = await check([passingStyle, "--max-sample-tiles", "0"]);
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  // A sample that did not contain something is not proof it is missing, so no
  // flag may turn absence into a build failure on its own.
  it("refuses to raise sampled absence to broken", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { code } = await check([passingStyle, "--sampled-absence", "broken"]);
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  it("raises sampled absence when asked", async () => {
    const { stdout } = await check([
      resolve(root, "fixtures/unlabeled-source/style.json"),
      "--sampled-absence",
      "risky",
      "--format",
      "json"
    ]);

    const absence = JSON.parse(stdout).findings.filter((finding: { id: string }) =>
      finding.id.includes("not-sampled")
    );
    expect(absence.length).toBeGreaterThan(0);
    expect(absence.every((finding: { severity: string }) => finding.severity === "risky")).toBe(
      true
    );
  });

  it("prints the report JSON Schema", async () => {
    const stdout = captureStdout();
    try {
      const code = await run(["node", "maptiles-doctor", "schema"]);
      const schema = JSON.parse(stdout.chunks.join(""));

      expect(code).toBe(0);
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.properties.schemaVersion.const).toBe("1.0");
    } finally {
      stdout.restore();
    }
  });

  it("writes the schema to a file with --output", async () => {
    const output = join(workDir, "schema.json");
    const stdout = captureStdout();
    try {
      const code = await run(["node", "maptiles-doctor", "schema", "--output", output]);

      expect(code).toBe(0);
      expect(stdout.chunks.join("")).toBe("");
    } finally {
      stdout.restore();
    }
    expect(JSON.parse(await readFile(output, "utf8")).type).toBe("object");
  });

  it("returns exit code 2 for an invalid source override", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { code } = await check([passingStyle, "--source", "bogus"]);
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns exit code 2 for an unknown output format", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { code } = await check([passingStyle, "--format", "yaml"]);
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns exit code 2 for an unreadable style path", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { code } = await check([join(workDir, "does-not-exist.json")]);
      expect(code).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  // `value in severityRank` also answered yes for every inherited
  // `Object.prototype` name. `--fail-threshold toString` validated, every
  // severity comparison against a function came out false, and a report holding
  // two broken findings exited 0 — a silent CI gate bypass.
  it.each(["toString", "constructor", "hasOwnProperty", "__proto__"])(
    "rejects the inherited property %s as a fail threshold",
    async (value) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { code } = await check([brokenStyle, "--fail-threshold", value]);
        expect(code).toBe(2);
      } finally {
        stderr.mockRestore();
      }
    }
  );

  it("still fails a broken style rather than passing it through an inherited threshold", async () => {
    const { code, stdout } = await check([
      brokenStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--format",
      "json"
    ]);

    const report = JSON.parse(stdout);
    expect(report.summary.broken).toBeGreaterThan(0);
    expect(report.status).toBe("failed");
    expect(code).toBe(1);
  });

  // A sample that did not contain something is not proof that it is missing, so
  // no flag may turn absence into a build failure on its own. The rejection is
  // deliberate and carries its own message.
  it("refuses to let sampled absence be raised to broken", async () => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--sampled-absence", "broken"]);
      expect(code).toBe(2);
      expect(stderr.text()).toContain("cannot prove a break");
    } finally {
      stderr.restore();
    }
  });

  it.each(["info", "warning", "risky"])(
    "accepts %s as a sampled-absence severity",
    async (value) => {
      const { code } = await check([
        passingStyle,
        "--source",
        `openmaptiles=${tilejson}`,
        "--sampled-absence",
        value
      ]);

      expect(code).toBe(0);
    }
  );

  it.each([
    ["200,0", "a longitude beyond 180"],
    ["0,100", "a latitude beyond 90"],
    ["0", "a single number"],
    ["0,0,0", "three numbers"],
    ["north,south", "words"]
  ])("rejects %s as --sample-at (%s)", async (value) => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--sample-at", value]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it("accepts a sample location on the boundary", async () => {
    const { code } = await check([
      passingStyle,
      "--source",
      `openmaptiles=${tilejson}`,
      "--sample-at",
      "-180,-90"
    ]);

    expect(code).toBe(0);
  });

  it.each(["0", "-1", "1.5", "many"])("rejects %s as a tile count", async (value) => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--max-sample-tiles", value]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it.each(["-0.1", "1.1", "half"])("rejects %s as a diff ratio", async (value) => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--max-diff-ratio", value]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it.each([
    ["id-only", "no separator"],
    ["=/tmp/x", "no id"],
    ["id=", "no location"]
  ])("rejects %s as a --source override (%s)", async (value) => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--source", value]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it("keeps a location containing an equals sign intact", async () => {
    // Only the first `=` separates the id, so a signed URL survives.
    const { code, stdout } = await check([
      passingStyle,
      "--source",
      "ghost=https://tiles.invalid.test/a.json?token=a=b",
      "--offline",
      "--format",
      "json"
    ]);

    const report = JSON.parse(stdout);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        id: "source.ghost.unused",
        path: "https://tiles.invalid.test/a.json?token=a=b"
      })
    );
    expect(code).toBe(0);
  });

  it("rejects a canary file that is not an array", async () => {
    const canaryFile = join(workDir, "canaries.json");
    await writeFile(canaryFile, JSON.stringify({ id: "one" }));
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--canaries", canaryFile]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it.each([
    ["0,0", "only two numbers"],
    ["0,0,2,extra,more", "too many parts"],
    ["a,b,c", "words"]
  ])("rejects %s as a --canary (%s)", async (value) => {
    const stderr = captureStderr();
    try {
      const { code } = await check([passingStyle, "--canary", value]);
      expect(code).toBe(2);
    } finally {
      stderr.restore();
    }
  });

  it("annotates info findings as notices, not warnings, for GitHub", async () => {
    const { stdout } = await check([
      resolve(root, "fixtures/stale-metadata/style.json"),
      "--format",
      "github"
    ]);

    expect(stdout).toContain("::notice title=expression-property::");
    expect(stdout).not.toContain("::warning title=expression-property::");
  });

  // `--format json | head` used to end in an unhandled 'error' event and a
  // stack trace, on a run that had already produced its report correctly.
  describe("broken pipe", () => {
    it("exits 0 when the reader closes stdout", () => {
      const stream = new PassThrough();
      const exit = vi.fn() as unknown as (code: number) => never;
      guardBrokenPipe(stream, exit);

      const epipe: NodeJS.ErrnoException = new Error("write EPIPE");
      epipe.code = "EPIPE";
      stream.emit("error", epipe);

      expect(exit).toHaveBeenCalledWith(0);
    });

    it("still raises every other stdout error", () => {
      const stream = new PassThrough();
      const exit = vi.fn() as unknown as (code: number) => never;
      guardBrokenPipe(stream, exit);

      const other: NodeJS.ErrnoException = new Error("no space left on device");
      other.code = "ENOSPC";

      expect(() => stream.emit("error", other)).toThrow("no space left on device");
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
