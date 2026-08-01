// Minimal stand-in for the `vscode` module, which only exists inside the editor
// host. vitest.config.ts aliases `vscode` to this file. It implements just the
// surface packages/vscode/src/extension.ts uses.
import { readFileSync } from "node:fs";

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    start: Position | number,
    startCharacter: Position | number,
    endLine?: number,
    endCharacter?: number
  ) {
    if (start instanceof Position && startCharacter instanceof Position) {
      this.start = start;
      this.end = startCharacter;
      return;
    }
    this.start = new Position(start as number, startCharacter as number);
    this.end = new Position(endLine ?? 0, endCharacter ?? 0);
  }
}

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3
} as const;

export const ViewColumn = {
  Active: -1,
  Beside: -2
} as const;

export class Diagnostic {
  source?: string;
  code?: string;

  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number
  ) {}
}

export interface StubUri {
  fsPath: string;
  toString(): string;
}

export class StubDocument {
  readonly uri: StubUri;
  /** VS Code increments this on every change to the buffer. */
  version = 1;

  constructor(
    fsPath: string,
    private text: string,
    readonly languageId: string
  ) {
    this.uri = { fsPath, toString: () => fsPath };
  }

  getText(): string {
    return this.text;
  }

  /** Replaces the buffer's text as an edit would, version bump included. */
  edit(text: string): void {
    this.text = text;
    this.version += 1;
  }

  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset);
    const line = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    return new Position(line, offset - lineStart);
  }
}

export class DiagnosticCollection {
  readonly entries = new Map<string, Diagnostic[]>();
  disposed = false;

  constructor(readonly name: string) {}

  set(uri: StubUri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.fsPath, diagnostics);
  }

  delete(uri: StubUri): void {
    this.entries.delete(uri.fsPath);
  }

  dispose(): void {
    this.disposed = true;
  }
}

export const languages = {
  collections: [] as DiagnosticCollection[],
  createDiagnosticCollection(name: string): DiagnosticCollection {
    const collection = new DiagnosticCollection(name);
    languages.collections.push(collection);
    return collection;
  }
};

export const commands = {
  registry: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    commands.registry.set(id, handler);
    return { dispose(): void {} };
  }
};

export interface StubWebviewPanel {
  viewType: string;
  title: string;
  webview: { html: string };
}

export const window = {
  activeTextEditor: undefined as { document: StubDocument } | undefined,
  warnings: [] as string[],
  infos: [] as string[],
  panels: [] as StubWebviewPanel[],
  showWarningMessage(message: string): void {
    window.warnings.push(message);
  },
  showInformationMessage(message: string): void {
    window.infos.push(message);
  },
  createWebviewPanel(viewType: string, title: string): StubWebviewPanel {
    const panel: StubWebviewPanel = { viewType, title, webview: { html: "" } };
    window.panels.push(panel);
    return panel;
  }
};

type DocumentListener = (document: StubDocument) => unknown;
type ConfigurationListener = (event: { affectsConfiguration(section: string): boolean }) => unknown;

export const workspace = {
  configuration: {} as Record<string, unknown>,
  textDocuments: [] as StubDocument[],
  workspaceFolder: undefined as string | undefined,
  listeners: {
    open: [] as DocumentListener[],
    save: [] as DocumentListener[],
    close: [] as DocumentListener[],
    configuration: [] as ConfigurationListener[]
  },
  getConfiguration(_section: string, _scope?: unknown) {
    return {
      get<T>(key: string, defaultValue: T): T {
        return (workspace.configuration[key] as T) ?? defaultValue;
      }
    };
  },
  getWorkspaceFolder(_uri: StubUri): { uri: StubUri } | undefined {
    if (!workspace.workspaceFolder) {
      return undefined;
    }
    const fsPath = workspace.workspaceFolder;
    return { uri: { fsPath, toString: () => fsPath } };
  },
  onDidOpenTextDocument(listener: DocumentListener) {
    workspace.listeners.open.push(listener);
    return { dispose(): void {} };
  },
  onDidSaveTextDocument(listener: DocumentListener) {
    workspace.listeners.save.push(listener);
    return { dispose(): void {} };
  },
  onDidCloseTextDocument(listener: DocumentListener) {
    workspace.listeners.close.push(listener);
    return { dispose(): void {} };
  },
  onDidChangeConfiguration(listener: ConfigurationListener) {
    workspace.listeners.configuration.push(listener);
    return { dispose(): void {} };
  }
};

export function resetStub(): void {
  languages.collections.length = 0;
  commands.registry.clear();
  window.activeTextEditor = undefined;
  window.warnings.length = 0;
  window.infos.length = 0;
  window.panels.length = 0;
  workspace.configuration = {};
  workspace.textDocuments.length = 0;
  workspace.workspaceFolder = undefined;
  workspace.listeners.open.length = 0;
  workspace.listeners.save.length = 0;
  workspace.listeners.close.length = 0;
  workspace.listeners.configuration.length = 0;
}

/** Reads the file so a document carries the same text the checker would see. */
export function createDocument(
  fsPath: string,
  overrides?: { text?: string; languageId?: string }
): StubDocument {
  return new StubDocument(
    fsPath,
    overrides?.text ?? readFileSync(fsPath, "utf8"),
    overrides?.languageId ?? "json"
  );
}

/** Dispatches the editor events the extension subscribes to. */
export async function fire(
  event: "open" | "save" | "close",
  document: StubDocument
): Promise<void> {
  for (const listener of workspace.listeners[event]) {
    await listener(document);
  }
}

export async function fireConfigurationChange(section = "maptilesDoctor"): Promise<void> {
  for (const listener of workspace.listeners.configuration) {
    await listener({ affectsConfiguration: (candidate: string) => candidate === section });
  }
}
