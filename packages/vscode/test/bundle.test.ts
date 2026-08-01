import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

/**
 * A .vsix carries only the bundle, so these cases run it from outside the
 * workspace: nothing up the directory tree resolves @maptiles-doctor/core or
 * jsonc-parser, which is exactly what the extension host offers. `vscode`
 * itself is injected the way the host injects it.
 */
let workDir: string;

const vscodeStub = `
const listeners = { open: [], save: [], close: [], configuration: [] };
const state = { commands: [], collections: [], diagnostics: null };
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b, c, d) { this.start = a instanceof Position ? a : new Position(a, b); this.end = a instanceof Position ? b : new Position(c, d); } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
module.exports = {
  Position,
  Range,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ViewColumn: { Beside: -2 },
  languages: {
    createDiagnosticCollection(name) {
      const collection = { name, set: (uri, items) => { state.diagnostics = items; }, delete() {}, dispose() {} };
      state.collections.push(collection);
      return collection;
    }
  },
  commands: {
    registerCommand(id, handler) { state.commands.push([id, handler]); return { dispose() {} }; }
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage() {},
    showInformationMessage() {},
    createWebviewPanel: () => ({ webview: {} })
  },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: () => undefined,
    onDidOpenTextDocument: (fn) => (listeners.open.push(fn), { dispose() {} }),
    onDidSaveTextDocument: (fn) => (listeners.save.push(fn), { dispose() {} }),
    onDidCloseTextDocument: (fn) => (listeners.close.push(fn), { dispose() {} }),
    onDidChangeConfiguration: (fn) => (listeners.configuration.push(fn), { dispose() {} })
  },
  __state: state,
  __listeners: listeners
};
`;

const driver = (stylePath: string) => `
const vscode = require("vscode");
const { readFileSync } = require("node:fs");
const extension = require("./extension.cjs");

const document = {
  languageId: "json",
  uri: { fsPath: ${JSON.stringify(stylePath)}, toString: () => ${JSON.stringify(stylePath)} },
  getText: () => readFileSync(${JSON.stringify(stylePath)}, "utf8"),
  positionAt: () => new vscode.Position(0, 0)
};

async function main() {
  extension.activate({ subscriptions: [] });
  vscode.window.activeTextEditor = { document };
  const check = vscode.__state.commands.find(([id]) => id === "maptilesDoctor.check");
  await check[1]();
  console.log(
    JSON.stringify({
      commands: vscode.__state.commands.map(([id]) => id),
      codes: (vscode.__state.diagnostics ?? []).map((diagnostic) => diagnostic.code)
    })
  );
  extension.deactivate();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

beforeAll(async () => {
  await execFileAsync(process.execPath, [resolve(root, "scripts/bundle-vscode.mjs")]);
  workDir = await mkdtemp(join(tmpdir(), "maptiles-doctor-vsix-"));
  await copyFile(
    resolve(root, "packages/vscode/extension-dist/extension.cjs"),
    join(workDir, "extension.cjs")
  );
  const stubDir = join(workDir, "node_modules", "vscode");
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    join(stubDir, "package.json"),
    JSON.stringify({ name: "vscode", main: "index.js" })
  );
  await writeFile(join(stubDir, "index.js"), vscodeStub);
}, 60_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("bundled VS Code extension", () => {
  it("activates and checks a style with nothing but the bundle on disk", async () => {
    const stylePath = join(import.meta.dirname, "../../../fixtures/broken-style/style.json");
    await writeFile(join(workDir, "driver.cjs"), driver(stylePath));

    const { stdout } = await execFileAsync(process.execPath, [join(workDir, "driver.cjs")], {
      cwd: workDir
    });
    const result = JSON.parse(stdout) as { commands: string[]; codes: string[] };

    expect(result.commands).toEqual(["maptilesDoctor.check", "maptilesDoctor.openReport"]);
    expect(result.codes).toContain("layer.3d-buildings.missing-source-layer");
  }, 60_000);
});
