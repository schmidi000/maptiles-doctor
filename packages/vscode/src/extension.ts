import { dirname, isAbsolute, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import * as vscode from "vscode";
import {
  checkStyleContract,
  type DoctorReport,
  type DoctorSourceInput,
  type Finding,
  type Severity
} from "@maptiles-doctor/core";
import { renderHtmlReport } from "@maptiles-doctor/report";
import { indexStyle, locateFinding, locateIncompleteCheck, type TextSpan } from "./locate.js";

/**
 * Last report per document, so "Open Report" does not have to re-run a check.
 * Keyed with the document version the report was produced from: a report about
 * text the buffer no longer holds is not a cache hit, it is a wrong answer.
 */
const reports = new Map<string, { version: number; report: DoctorReport }>();

/**
 * Newest check started per document. A check reads the network, so an older,
 * slower one can finish after a newer one and overwrite it with a stale result.
 * Only the newest generation is allowed to publish.
 */
const generations = new Map<string, number>();

function cachedReport(document: vscode.TextDocument): DoctorReport | undefined {
  const entry = reports.get(document.uri.toString());
  return entry && entry.version === document.version ? entry.report : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("maptiles-doctor");
  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand("maptilesDoctor.check", async () => {
      const document = activeStyleDocument();
      if (!document) {
        return;
      }
      const report = await runCheck(document, diagnostics);
      if (report) {
        vscode.window.showInformationMessage(statusMessage(report));
      }
    }),
    vscode.commands.registerCommand("maptilesDoctor.openReport", async () => {
      const document = activeStyleDocument();
      if (!document) {
        return;
      }
      const report = cachedReport(document) ?? (await runCheck(document, diagnostics));
      if (report) {
        showReport(document, report);
      }
    }),
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (settings(document).checkOnOpen) {
        await checkQuietly(document, diagnostics);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (settings(document).checkOnSave) {
        await checkQuietly(document, diagnostics);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      reports.delete(document.uri.toString());
      generations.delete(document.uri.toString());
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("maptilesDoctor")) {
        return;
      }
      // Source overrides and sampling flags change what a check concludes, so
      // stale diagnostics have to be recomputed rather than left on screen.
      for (const document of vscode.workspace.textDocuments) {
        await checkQuietly(document, diagnostics);
      }
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    void checkQuietly(document, diagnostics);
  }
}

export function deactivate(): void {
  reports.clear();
  generations.clear();
}

/** Returns the active style document, warning the user when there is none. */
function activeStyleDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || !isStyleDocument(document)) {
    vscode.window.showWarningMessage(
      "Open a MapLibre/Mapbox style JSON file before running MapTiles Doctor."
    );
    return undefined;
  }
  return document;
}

/**
 * A style is a JSON document with a spec version and a layers array. Guessing
 * from the file name would either miss `basemap.json` or lint every
 * `tsconfig.json` in the workspace.
 */
export function isStyleDocument(document: vscode.TextDocument): boolean {
  if (document.languageId !== "json" && document.languageId !== "jsonc") {
    return false;
  }
  const { tree } = indexStyle(document.getText());
  if (!tree || tree.type !== "object") {
    return false;
  }
  const keys = new Set(
    (tree.children ?? []).map((property) => String(property.children?.[0]?.value ?? ""))
  );
  return keys.has("version") && keys.has("layers");
}

async function checkQuietly(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): Promise<void> {
  if (!isStyleDocument(document)) {
    // An edit can take a buffer out of style shape — a deleted `layers` key
    // mid-typing. Leaving the last run's diagnostics on screen would keep
    // reporting on a document that no longer exists.
    reports.delete(document.uri.toString());
    generations.delete(document.uri.toString());
    diagnostics.delete(document.uri);
    return;
  }
  await runCheck(document, diagnostics);
}

/**
 * Core parses a style with strict `JSON.parse`, so a JSONC buffer handed over
 * verbatim came straight back as a `check-failed` diagnostic for invalid JSON —
 * after the extension had activated for `jsonc` and claimed the document as a
 * style. VS Code puts plenty of ordinary, comment-free style files in `jsonc`
 * mode through file associations, so refusing them outright would stop checking
 * valid styles; re-serializing what `jsonc-parser` read is what makes the claim
 * honest.
 *
 * Only `jsonc` is normalized. A `json` document stays byte-for-byte what core
 * and the CLI see, so the editor never reports clean on something CI rejects.
 * Diagnostics are still anchored against the original buffer, which
 * `jsonc-parser` reads directly.
 */
function styleTextForCore(document: vscode.TextDocument, text: string): string {
  if (document.languageId !== "jsonc") {
    return text;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  // Anything the JSONC reader could not make sense of goes to core unchanged, so
  // the invalid-JSON message a user sees describes their actual text.
  return errors.length > 0 || parsed === undefined ? text : JSON.stringify(parsed);
}

async function runCheck(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): Promise<DoctorReport | undefined> {
  const key = document.uri.toString();
  const text = document.getText();
  const version = document.version;
  const config = settings(document);

  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  // Open, save, and configuration changes each start a check, so several can be
  // in flight at once. Anything but the newest is discarded on completion
  // rather than allowed to overwrite a fresher result.
  const superseded = (): boolean => generations.get(key) !== generation;

  let report: DoctorReport;
  try {
    report = await checkStyleContract({
      stylePath: document.uri.fsPath,
      // The buffer, not the file: an editor has to report on what is on screen.
      styleText: styleTextForCore(document, text),
      sources: resolveSources(document, config.sources),
      failThreshold: config.failThreshold,
      allowNetwork: !config.offline,
      sampleTiles: config.sampleTiles,
      maxSampleTiles: config.maxSampleTiles,
      timeoutMs: config.timeoutMs
    });
  } catch (error) {
    if (superseded()) {
      return undefined;
    }
    reports.delete(key);
    diagnostics.set(document.uri, [
      documentDiagnostic(
        document,
        `MapTiles Doctor could not check this style: ${error instanceof Error ? error.message : String(error)}`,
        "check-failed"
      )
    ]);
    return undefined;
  }

  if (superseded()) {
    return undefined;
  }
  reports.set(key, { version, report });
  diagnostics.set(document.uri, toDiagnostics(document, text, report));
  return report;
}

function toDiagnostics(
  document: vscode.TextDocument,
  text: string,
  report: DoctorReport
): vscode.Diagnostic[] {
  const index = indexStyle(text);

  const findingDiagnostics = report.findings.map((finding) => {
    const diagnostic = new vscode.Diagnostic(
      spanToRange(document, locateFinding(index, finding)),
      findingMessage(finding),
      diagnosticSeverity(finding.severity)
    );
    diagnostic.source = "MapTiles Doctor";
    diagnostic.code = finding.id;
    return diagnostic;
  });

  // Incomplete checks are not failures, but hiding them is how a network blip
  // turns into a silent pass.
  const incompleteDiagnostics = report.incompleteChecks.map((check) => {
    const diagnostic = new vscode.Diagnostic(
      spanToRange(document, locateIncompleteCheck(index, check)),
      `Incomplete check: ${check.message}`,
      vscode.DiagnosticSeverity.Information
    );
    diagnostic.source = "MapTiles Doctor";
    diagnostic.code = check.id;
    return diagnostic;
  });

  return [...findingDiagnostics, ...incompleteDiagnostics];
}

function findingMessage(finding: Finding): string {
  return finding.suggestion
    ? `${finding.message} Did you mean ${finding.suggestion}?`
    : finding.message;
}

function diagnosticSeverity(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case "broken":
      return vscode.DiagnosticSeverity.Error;
    case "risky":
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function spanToRange(document: vscode.TextDocument, span: TextSpan | undefined): vscode.Range {
  if (!span) {
    return new vscode.Range(0, 0, 0, 1);
  }
  return new vscode.Range(
    document.positionAt(span.offset),
    document.positionAt(span.offset + span.length)
  );
}

function documentDiagnostic(
  document: vscode.TextDocument,
  message: string,
  code: string
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    spanToRange(document, undefined),
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = "MapTiles Doctor";
  diagnostic.code = code;
  return diagnostic;
}

function showReport(document: vscode.TextDocument, report: DoctorReport): void {
  const panel = vscode.window.createWebviewPanel(
    "maptilesDoctorReport",
    `MapTiles Doctor: ${basename(document.uri.fsPath)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = renderHtmlReport(report);
}

function statusMessage(report: DoctorReport): string {
  return `MapTiles Doctor: ${report.status} (${report.findings.length} finding(s), ${report.incompleteChecks.length} incomplete check(s)).`;
}

interface ExtensionSettings {
  sources: Record<string, string>;
  failThreshold: Severity;
  offline: boolean;
  sampleTiles: boolean;
  maxSampleTiles: number;
  timeoutMs: number;
  checkOnOpen: boolean;
  checkOnSave: boolean;
}

function settings(document: vscode.TextDocument): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("maptilesDoctor", document.uri);
  return {
    sources: config.get<Record<string, string>>("sources", {}),
    failThreshold: config.get<Severity>("failThreshold", "broken"),
    offline: config.get<boolean>("offline", false),
    sampleTiles: config.get<boolean>("sampleTiles", true),
    maxSampleTiles: config.get<number>("maxSampleTiles", 3),
    timeoutMs: config.get<number>("timeoutMs", 10_000),
    checkOnOpen: config.get<boolean>("checkOnOpen", true),
    checkOnSave: config.get<boolean>("checkOnSave", true)
  };
}

/**
 * Settings are usually written relative to the workspace, e.g.
 * `tiles/world.pmtiles`, so a relative location resolves against the workspace
 * folder and falls back to the style's own directory.
 */
function resolveSources(
  document: vscode.TextDocument,
  sources: Record<string, string>
): DoctorSourceInput[] {
  const base =
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dirname(document.uri.fsPath);
  return Object.entries(sources).map(([id, location]) => ({
    id,
    location: isRemote(location) || isAbsolute(location) ? location : resolve(base, location)
  }));
}

function isRemote(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
