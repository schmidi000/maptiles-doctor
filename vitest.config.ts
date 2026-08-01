import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds fixtures/generated/*.pmtiles|*.mbtiles before any suite runs.
    globalSetup: [resolve(import.meta.dirname, "scripts/vitest-global-setup.mjs")],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // The action bundle entrypoint is exercised out of process by the bundle
      // suite, so v8 cannot attribute it. A bare path here would drop the whole
      // directory from the report, so the pattern has to be a glob.
      exclude: ["**/action/src/main.ts"],
      // Known gap: packages/action/src drops out of a combined run because its
      // suite intercepts a module with vi.mock. Run that suite alone to see the
      // real number; action/src/index.ts sits at 92%.
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85
      }
    }
  },
  resolve: {
    alias: {
      // The `vscode` module only exists inside the editor host; tests run
      // against a stub that mirrors the API surface the extension uses.
      vscode: resolve(import.meta.dirname, "packages/vscode/test/vscode-stub.ts")
    }
  }
});
