// Findings identify a layer, source, or asset by name, not by document
// position. Editor diagnostics need a position, so this module maps a finding
// back onto the style JSON node that caused it. It is deliberately free of any
// `vscode` import: it works on text and offsets, so it is testable on its own.
import { findNodeAtLocation, type Node, parseTree, type Segment } from "jsonc-parser";
import type { Finding, IncompleteCheck } from "@maptiles-doctor/core";

export interface TextSpan {
  offset: number;
  length: number;
}

/** Parsed once per check so every finding of a document reuses the same tree. */
export interface StyleIndex {
  text: string;
  tree: Node | undefined;
}

export function indexStyle(text: string): StyleIndex {
  return { text, tree: parseTree(text, [], { allowTrailingComma: true }) };
}

/**
 * Returns the narrowest node that explains the finding, or undefined when the
 * style has no node for it. Callers fall back to the start of the document,
 * because a diagnostic nobody can see is worse than an imprecise one.
 */
export function locateFinding(index: StyleIndex, finding: Finding): TextSpan | undefined {
  if (!index.tree) {
    return undefined;
  }

  if (finding.category === "style-spec" && finding.path) {
    const span = spanAt(index, styleSpecSegments(finding.path));
    if (span) {
      return span;
    }
  }

  if (finding.layerId) {
    const span = locateInLayer(index, finding);
    if (span) {
      return span;
    }
  }

  if (finding.category === "icon") {
    return locateIconLayer(index, finding) ?? spanAt(index, ["sprite"]);
  }

  if (finding.category === "glyph") {
    return spanAt(index, ["glyphs"]);
  }

  if (finding.category === "sprite") {
    return spanAt(index, ["sprite"]);
  }

  if (finding.sourceId) {
    return locateSource(index, finding.sourceId);
  }

  return undefined;
}

export function locateIncompleteCheck(
  index: StyleIndex,
  check: IncompleteCheck
): TextSpan | undefined {
  if (!index.tree) {
    return undefined;
  }
  if (check.category === "glyph") {
    return spanAt(index, ["glyphs"]);
  }
  if (check.category === "sprite") {
    return spanAt(index, ["sprite"]);
  }
  if (check.sourceId) {
    return locateSource(index, check.sourceId);
  }
  return undefined;
}

function locateSource(index: StyleIndex, sourceId: string): TextSpan | undefined {
  return spanAt(index, ["sources", sourceId]) ?? spanAt(index, ["sources"]);
}

function locateInLayer(index: StyleIndex, finding: Finding): TextSpan | undefined {
  const position = layerIndex(index, finding.layerId!);
  if (position === undefined) {
    return undefined;
  }

  const layer: Segment[] = ["layers", position];
  for (const candidate of layerCandidates(finding)) {
    const span = spanAt(index, [...layer, ...candidate]);
    if (span) {
      return span;
    }
  }
  // The layer's own id is still a better anchor than line 1.
  return spanAt(index, [...layer, "id"]) ?? spanAt(index, layer);
}

function layerCandidates(finding: Finding): Segment[][] {
  switch (finding.category) {
    case "source-layer":
      return [["source-layer"]];
    case "source":
      return [["source"]];
    case "zoom":
      return [["minzoom"], ["maxzoom"]];
    case "icon":
      return [["layout", "icon-image"]];
    case "glyph":
      return [["layout", "text-font"]];
    case "expression-property":
      // The property can appear in any of these, and the first hit is the most
      // likely place a reader will look for it.
      return [["filter"], ["layout"], ["paint"]];
    default:
      return [];
  }
}

function locateIconLayer(index: StyleIndex, finding: Finding): TextSpan | undefined {
  const icon = iconName(finding);
  if (!icon) {
    return undefined;
  }
  const layers = findNodeAtLocation(index.tree!, ["layers"]);
  for (const [position, layer] of (layers?.children ?? []).entries()) {
    const iconImage = findNodeAtLocation(layer, ["layout", "icon-image"]);
    if (iconImage && nodeText(index, iconImage).includes(`"${icon}"`)) {
      return spanAt(index, ["layers", position, "layout", "icon-image"]);
    }
  }
  return undefined;
}

/** `sprite.icon.<name>.missing` is the only producer of icon findings. */
function iconName(finding: Finding): string | undefined {
  const match = /^sprite\.icon\.(.+)\.missing$/.exec(finding.id);
  return match?.[1];
}

function layerIndex(index: StyleIndex, layerId: string): number | undefined {
  const layers = findNodeAtLocation(index.tree!, ["layers"]);
  const position = (layers?.children ?? []).findIndex(
    (layer) => findNodeAtLocation(layer, ["id"])?.value === layerId
  );
  return position === -1 ? undefined : position;
}

/**
 * Style-spec errors report a key like `layers[3].paint.fill-color`. Turning it
 * into segments keeps the diagnostic on the offending property instead of the
 * whole file.
 */
function styleSpecSegments(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const part of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      return [];
    }
    if (match[1]) {
      segments.push(match[1]);
    }
    for (const indexMatch of match[2]?.matchAll(/\[(\d+)\]/g) ?? []) {
      segments.push(Number(indexMatch[1]));
    }
  }
  return segments;
}

function spanAt(index: StyleIndex, segments: Segment[]): TextSpan | undefined {
  if (!index.tree || segments.length === 0) {
    return undefined;
  }
  const node = findNodeAtLocation(index.tree, segments);
  if (!node) {
    return undefined;
  }

  const property = node.parent?.type === "property" ? node.parent : undefined;
  // Marking `"source-layer": "building"` reads well; dragging a squiggle over
  // a whole multi-line `sources` or `paint` block does not, so those are
  // marked by their key alone.
  const anchor =
    property && nodeText(index, property).includes("\n")
      ? (property.children?.[0] ?? node)
      : (property ?? node);
  return { offset: anchor.offset, length: Math.max(anchor.length, 1) };
}

function nodeText(index: StyleIndex, node: Node): string {
  return index.text.slice(node.offset, node.offset + node.length);
}
