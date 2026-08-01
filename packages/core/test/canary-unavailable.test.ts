import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkStyleContract } from "../src/checker.js";

// A machine with no browser is the common case for `npx maptiles-doctor` and
// for the bundled GitHub Action, where playwright is deliberately external.
vi.mock("playwright", () => ({
  chromium: {
    launch: () => {
      throw new Error("Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium");
    }
  }
}));

const canaryStyle = resolve(import.meta.dirname, "../../../fixtures/canary-style/style.json");

describe("visual canaries without a browser", () => {
  it("reports an incomplete check instead of passing or failing", async () => {
    const report = await checkStyleContract({
      stylePath: canaryStyle,
      canaries: [{ id: "origin", center: [0, 0], zoom: 0 }],
      sampleTiles: false
    });

    const unavailable = report.incompleteChecks.find((check) => check.id === "canary.unavailable");
    expect(unavailable?.category).toBe("visual-canary");
    expect(unavailable?.message).toContain("Could not launch Chromium");

    expect(report.checks.find((check) => check.id === "visual-canary")?.status).toBe("incomplete");
    expect(report.findings.filter((finding) => finding.category === "visual-canary")).toEqual([]);
    expect(report.status).toBe("incomplete");
  });

  it("does not add a visual-canary check when no canary is configured", async () => {
    const report = await checkStyleContract({ stylePath: canaryStyle, sampleTiles: false });

    expect(report.checks.map((check) => check.id)).not.toContain("visual-canary");
  });
});
