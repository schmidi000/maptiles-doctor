import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, deactivate, isStyleDocument } from "../src/extension.js";
import {
  commands,
  createDocument,
  Diagnostic,
  DiagnosticSeverity,
  fire,
  fireConfigurationChange,
  languages,
  resetStub,
  window,
  workspace,
  type DiagnosticCollection,
  type StubDocument
} from "./vscode-stub.js";

const root = resolve(import.meta.dirname, "../../..");
const fixtures = resolve(root, "fixtures");
const tilejson = resolve(fixtures, "simple-style/tilejson.json");

interface StubContext {
  subscriptions: { dispose(): void }[];
}

function activateExtension(): { context: StubContext; collection: DiagnosticCollection } {
  const context: StubContext = { subscriptions: [] };
  activate(context as never);
  const collection = languages.collections[0];
  if (!collection) {
    throw new Error("activate() did not create a diagnostic collection");
  }
  return { context, collection };
}

function styleDocument(fixture: string, overrides?: { text?: string }): StubDocument {
  return createDocument(resolve(fixtures, `${fixture}/style.json`), overrides);
}

function openInEditor(document: StubDocument): void {
  window.activeTextEditor = { document };
  workspace.textDocuments.push(document);
}

async function runCommand(id: string): Promise<void> {
  const handler = commands.registry.get(id);
  if (!handler) {
    throw new Error(`${id} was not registered`);
  }
  await handler();
}

function diagnosticsFor(collection: DiagnosticCollection, document: StubDocument): Diagnostic[] {
  return collection.entries.get(document.uri.fsPath) ?? [];
}

beforeEach(() => {
  resetStub();
  // The report cache lives for the lifetime of the extension host.
  deactivate();
});

describe("activation", () => {
  it("registers both commands, a diagnostic collection, and the editor listeners", () => {
    const { context, collection } = activateExtension();

    expect(collection.name).toBe("maptiles-doctor");
    expect([...commands.registry.keys()]).toEqual([
      "maptilesDoctor.check",
      "maptilesDoctor.openReport"
    ]);
    expect(context.subscriptions).toHaveLength(7);
  });

  it("checks style files that are already open", async () => {
    const document = styleDocument("broken-style");
    workspace.textDocuments.push(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    const { collection } = activateExtension();

    // The activation-time check is fire-and-forget: nothing to await but the
    // diagnostics showing up.
    await vi.waitFor(() => expect(diagnosticsFor(collection, document).length).toBeGreaterThan(0));
  });
});

describe("the check command", () => {
  it("warns instead of running when no editor is active", async () => {
    const { collection } = activateExtension();

    await runCommand("maptilesDoctor.check");

    expect(window.warnings).toEqual([
      "Open a MapLibre/Mapbox style JSON file before running MapTiles Doctor."
    ]);
    expect(collection.entries.size).toBe(0);
  });

  it("warns when the active document is JSON but not a style", async () => {
    const { collection } = activateExtension();
    openInEditor(createDocument(resolve(root, "package.json")));

    await runCommand("maptilesDoctor.check");

    expect(window.warnings).toHaveLength(1);
    expect(collection.entries.size).toBe(0);
  });

  it("publishes a located error diagnostic per broken finding", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.check");

    const diagnostics = diagnosticsFor(collection, document);
    expect(diagnostics.every((diagnostic) => diagnostic.source === "MapTiles Doctor")).toBe(true);

    const sourceLayer = diagnostics.find(
      (diagnostic) => diagnostic.code === "layer.3d-buildings.missing-source-layer"
    );
    expect(sourceLayer?.severity).toBe(DiagnosticSeverity.Error);
    // `"source-layer": "building"` sits on line 16 of the fixture.
    expect(sourceLayer?.range.start.line).toBe(15);
    expect(sourceLayer?.range.end.line).toBe(15);
    expect(sourceLayer?.message).toContain("Did you mean buildings?");

    const risky = diagnostics.find((diagnostic) => diagnostic.code?.endsWith("not-observed"));
    expect(risky?.severity).toBe(DiagnosticSeverity.Warning);
    expect(window.infos[0]).toContain("failed");
  });

  it("clears diagnostics when a style passes", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("simple-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.check");

    expect(diagnosticsFor(collection, document)).toEqual([]);
    expect(window.infos[0]).toContain("passed");
  });

  it("reports incomplete checks as information diagnostics", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("missing-sprite");
    openInEditor(document);

    await runCommand("maptilesDoctor.check");

    const incomplete = diagnosticsFor(collection, document).find(
      (diagnostic) => diagnostic.code === "sprite.index-unreadable"
    );
    expect(incomplete?.severity).toBe(DiagnosticSeverity.Information);
    expect(incomplete?.message).toContain("Incomplete check:");
    // `"sprite": "./sprite"` is on line 4 of the fixture.
    expect(incomplete?.range.start.line).toBe(3);
    expect(window.infos[0]).toContain("1 incomplete check(s)");
  });

  it("checks the unsaved buffer rather than the file on disk", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("simple-style", {
      text: styleDocument("simple-style")
        .getText()
        .replace('"source-layer": "buildings"', '"source-layer": "building"')
    });
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.check");

    const codes = diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("layer.buildings.missing-source-layer");
  });

  it("surfaces a check failure as a diagnostic instead of throwing", async () => {
    const { collection } = activateExtension();
    // Style-shaped but not valid JSON: an edit in progress.
    const document = styleDocument("simple-style", { text: '{ "version": 8, "layers": [ }' });
    openInEditor(document);

    await runCommand("maptilesDoctor.check");

    const diagnostics = diagnosticsFor(collection, document);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("check-failed");
    expect(diagnostics[0]?.severity).toBe(DiagnosticSeverity.Error);
    expect(diagnostics[0]?.message).toContain("not valid JSON");
    expect(window.infos).toEqual([]);
  });

  it("resolves relative source overrides against the workspace folder", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    openInEditor(document);
    workspace.workspaceFolder = fixtures;
    workspace.configuration = { sources: { openmaptiles: "simple-style/tilejson.json" } };

    await runCommand("maptilesDoctor.check");

    const codes = diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("layer.3d-buildings.missing-source-layer");
  });
});

describe("the open report command", () => {
  it("renders the cached report in a webview", async () => {
    activateExtension();
    const document = styleDocument("broken-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.check");
    await runCommand("maptilesDoctor.openReport");

    expect(window.panels).toHaveLength(1);
    expect(window.panels[0]?.viewType).toBe("maptilesDoctorReport");
    expect(window.panels[0]?.title).toBe("MapTiles Doctor: style.json");
    expect(window.panels[0]?.webview.html).toContain("MapTiles Doctor Report");
    expect(window.panels[0]?.webview.html).toContain("missing source-layer building");
  });

  // The cache was keyed by document URI alone, so a report produced from text
  // the buffer no longer holds was served as a hit and the panel showed the
  // previous edit's result.
  it("re-checks an edited buffer instead of serving the previous report", async () => {
    activateExtension();
    const document = styleDocument("broken-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.check");
    expect(window.panels).toHaveLength(0);

    // Fixing the source-layer is exactly what makes the cached report wrong.
    document.edit(document.getText().replace(/"building"/g, '"buildings"'));
    await runCommand("maptilesDoctor.openReport");

    expect(window.panels[0]?.webview.html).not.toContain("missing source-layer building");
  });

  it("runs a check first when no report is cached", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("simple-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await runCommand("maptilesDoctor.openReport");

    expect(window.panels[0]?.webview.html).toContain("Status: passed");
    expect(collection.entries.has(document.uri.fsPath)).toBe(true);
  });

  it("opens nothing when the check fails", async () => {
    activateExtension();
    openInEditor(styleDocument("simple-style", { text: '{ "version": 8, "layers": [ }' }));

    await runCommand("maptilesDoctor.openReport");

    expect(window.panels).toEqual([]);
  });
});

describe("editor events", () => {
  it("checks a style file when it is opened", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await fire("open", document);

    expect(diagnosticsFor(collection, document).length).toBeGreaterThan(0);
    // An automatic run stays quiet; only the command reports its status.
    expect(window.infos).toEqual([]);
  });

  it("honors checkOnOpen and checkOnSave being disabled", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.configuration = { checkOnOpen: false, checkOnSave: false };

    await fire("open", document);
    await fire("save", document);

    expect(collection.entries.size).toBe(0);
  });

  it("checks a style file when it is saved", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await fire("save", document);

    expect(diagnosticsFor(collection, document).length).toBeGreaterThan(0);
  });

  // Returning early left the last run's diagnostics on screen, so a buffer
  // edited out of style shape kept being reported on as though it still were.
  it("clears diagnostics when a checked buffer stops being style-shaped", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await fire("save", document);
    expect(diagnosticsFor(collection, document).length).toBeGreaterThan(0);

    document.edit(JSON.stringify({ version: 8 }));
    await fire("save", document);

    expect(collection.entries.has(document.uri.fsPath)).toBe(false);
  });

  it("ignores JSON files that are not styles", async () => {
    const { collection } = activateExtension();

    await fire("open", createDocument(resolve(root, "package.json")));
    await fire("save", createDocument(resolve(root, "tsconfig.json")));

    expect(collection.entries.size).toBe(0);
  });

  it("ignores documents in other languages", async () => {
    const { collection } = activateExtension();
    const style = styleDocument("broken-style");
    const yamlish = createDocument(style.uri.fsPath, {
      text: style.getText(),
      languageId: "yaml"
    });

    await fire("open", yamlish);

    expect(isStyleDocument(yamlish as never)).toBe(false);
    expect(collection.entries.size).toBe(0);
  });

  it("drops diagnostics when the document is closed", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.configuration = { sources: { openmaptiles: tilejson } };

    await fire("open", document);
    await fire("close", document);

    expect(collection.entries.has(document.uri.fsPath)).toBe(false);
  });

  it("rechecks open styles when the configuration changes", async () => {
    const { collection } = activateExtension();
    const document = styleDocument("broken-style");
    workspace.textDocuments.push(document);

    await fireConfigurationChange("editor.fontSize");
    expect(collection.entries.size).toBe(0);

    workspace.configuration = { sources: { openmaptiles: tilejson } };
    await fireConfigurationChange();

    const codes = diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("layer.3d-buildings.missing-source-layer");
  });
});

describe("deactivate", () => {
  it("drops cached reports without throwing", async () => {
    activateExtension();
    const document = styleDocument("simple-style");
    openInEditor(document);
    workspace.configuration = { sources: { openmaptiles: tilejson } };
    await runCommand("maptilesDoctor.check");

    expect(() => deactivate()).not.toThrow();

    // With the cache gone, opening the report has to run a fresh check.
    await runCommand("maptilesDoctor.openReport");
    expect(window.panels[0]?.webview.html).toContain("Status: passed");
  });
});

// Open, save, and configuration changes each start a check, and a check reads
// the network. Without a generation guard a slower older run finishes last and
// overwrites the newer report and its diagnostics.
describe("overlapping checks", () => {
  let server: Server;
  let origin = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      // Slow enough that the offline check started after it still finishes
      // first, which is the ordering that made the race visible.
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            tilejson: "3.0.0",
            minzoom: 0,
            maxzoom: 14,
            tiles: [`${origin}/{z}/{x}/{y}.mvt`],
            vector_layers: [{ id: "poi", fields: { name: "String" }, minzoom: 0, maxzoom: 14 }]
          })
        );
      }, 250);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  function remoteStyleDocument(): StubDocument {
    return createDocument(resolve(fixtures, "remote-source/style.json"), {
      text: JSON.stringify({
        version: 8,
        sources: { basemap: { type: "vector", url: `${origin}/tilejson.json` } },
        layers: [
          {
            id: "poi-labels",
            type: "symbol",
            source: "basemap",
            "source-layer": "poi",
            layout: { "text-field": ["get", "name"] }
          }
        ]
      })
    });
  }

  it("keeps the newer check's diagnostics when an older one finishes last", async () => {
    const { collection } = activateExtension();
    const document = remoteStyleDocument();
    openInEditor(document);

    // The online check reaches the delayed server; the offline one started
    // after it makes no request at all and completes immediately.
    workspace.configuration = { offline: false, timeoutMs: 5_000 };
    const older = fire("save", document);
    workspace.configuration = { offline: true, timeoutMs: 5_000 };
    const newer = fire("save", document);
    await Promise.all([older, newer]);

    expect(diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code)).toContain(
      "source.basemap.network-disabled"
    );
  });

  it("keeps the newer check's cached report when an older one finishes last", async () => {
    activateExtension();
    const document = remoteStyleDocument();
    openInEditor(document);

    workspace.configuration = { offline: false, timeoutMs: 5_000 };
    const older = fire("save", document);
    workspace.configuration = { offline: true, timeoutMs: 5_000 };
    const newer = fire("save", document);
    await Promise.all([older, newer]);

    await runCommand("maptilesDoctor.openReport");

    expect(window.panels[0]?.webview.html).toContain("network access is disabled");
  });
});

// The extension activates for `jsonc` and `isStyleDocument` accepts it, but core
// parses with strict `JSON.parse`. A valid JSONC style was therefore recognized
// as a style and immediately handed back a `check-failed` diagnostic for invalid
// JSON — the wrapper claimed the document and then rejected it.
describe("JSONC style documents", () => {
  const jsoncText = `{
  // A comment, which is the whole point of JSONC.
  "version": 8,
  "sources": {
    "openmaptiles": { "type": "vector", "url": "./tilejson.json" }
  },
  "layers": [
    {
      "id": "buildings",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "buildings",
    },
  ],
}`;

  function jsoncDocument(): StubDocument {
    return createDocument(resolve(fixtures, "simple-style/style.json"), {
      text: jsoncText,
      languageId: "jsonc"
    });
  }

  it("is recognized as a style", () => {
    expect(isStyleDocument(jsoncDocument() as never)).toBe(true);
  });

  it("is checked instead of rejected as invalid JSON", async () => {
    const { collection } = activateExtension();
    const document = jsoncDocument();
    openInEditor(document);

    await runCommand("maptilesDoctor.check");

    const codes = diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code);
    expect(codes).not.toContain("check-failed");
  });

  // A `json` document stays byte-for-byte what core and the CLI see, so the
  // editor never reports clean on something CI would reject.
  it("does not make comments acceptable in a plain JSON document", async () => {
    const { collection } = activateExtension();
    const document = createDocument(resolve(fixtures, "simple-style/style.json"), {
      text: jsoncText
    });
    openInEditor(document);

    await runCommand("maptilesDoctor.check");

    expect(diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code)).toContain(
      "check-failed"
    );
  });

  it("still reports genuinely broken JSONC as a check failure", async () => {
    const { collection } = activateExtension();
    const document = createDocument(resolve(fixtures, "simple-style/style.json"), {
      text: '{ "version": 8, "layers": [ }',
      languageId: "jsonc"
    });
    openInEditor(document);

    await runCommand("maptilesDoctor.check");

    expect(diagnosticsFor(collection, document).map((diagnostic) => diagnostic.code)).toContain(
      "check-failed"
    );
  });
});
