import {
  convertFilter,
  isExpression,
  type FilterSpecification
} from "@maplibre/maplibre-gl-style-spec";

/** One piece of an icon name: a fixed string, or a feature property to substitute. */
export type IconNamePart = { literal: string } | { property: string };

/** An `icon-image` whose name is only known once feature data is read. */
export interface IconNameTemplate {
  layerId: string;
  parts: IconNamePart[];
}

export interface StyleUsage {
  /** Names known from the style alone, checkable against the sprite index. */
  iconImages: Set<string>;
  /** Names built from feature data, checkable only against sampled tiles. */
  iconTemplates: IconNameTemplate[];
  /**
   * Layers whose `icon-image` could not be reduced to the names it produces.
   * The icons are neither checked nor silently assumed present: the sprite
   * check reports them incomplete.
   */
  unresolvedIcons: UnresolvedIcon[];
  fontStacks: Set<string>;
  properties: Map<string, Set<string>>;
}

export interface UnresolvedIcon {
  layerId: string;
  reason: string;
}

/** Property names every icon template reads, so tile sampling can record them. */
export function iconTemplateProperties(templates: IconNameTemplate[]): Set<string> {
  const properties = new Set<string>();
  for (const template of templates) {
    for (const part of template.parts) {
      if ("property" in part) {
        properties.add(part.property);
      }
    }
  }
  return properties;
}

/** Builds the name a template produces for one sampled feature, if it can. */
export function renderIconName(
  parts: IconNamePart[],
  values: Record<string, string | number | boolean>
): string | undefined {
  let name = "";
  for (const part of parts) {
    if ("literal" in part) {
      name += part.literal;
      continue;
    }
    const value = values[part.property];
    if (value === undefined) {
      return undefined;
    }
    name += String(value);
  }
  return name === "" ? undefined : name;
}

export function collectStyleUsage(style: unknown): StyleUsage {
  const usage: StyleUsage = {
    iconImages: new Set<string>(),
    iconTemplates: [],
    unresolvedIcons: [],
    fontStacks: new Set<string>(),
    properties: new Map<string, Set<string>>()
  };

  const styleRecord = asRecord(style);
  const layers = Array.isArray(styleRecord?.layers) ? styleRecord.layers : [];

  for (const layer of layers) {
    const layerRecord = asRecord(layer);
    const layerId = asString(layerRecord?.id) ?? "unknown-layer";
    scanValue(layerRecord?.layout, layerId, usage);
    scanValue(layerRecord?.paint, layerId, usage);
    scanValue(layerRecord?.filter, layerId, usage);

    const iconImage = asRecord(layerRecord?.layout)?.["icon-image"];
    const notes: string[] = [];
    for (const parts of collectIconNames(iconImage, notes)) {
      if (parts.every((part) => "literal" in part)) {
        usage.iconImages.add(parts.map((part) => ("literal" in part ? part.literal : "")).join(""));
      } else {
        usage.iconTemplates.push({ layerId, parts });
      }
    }
    for (const reason of new Set(notes)) {
      usage.unresolvedIcons.push({ layerId, reason });
    }

    const textFont = asRecord(layerRecord?.layout)?.["text-font"];
    collectStaticStrings(textFont).forEach((value) => usage.fontStacks.add(value));
  }

  return usage;
}

function scanValue(value: unknown, layerId: string, usage: StyleUsage): void {
  if (Array.isArray(value)) {
    if (value[0] === "get" && typeof value[1] === "string") {
      addProperty(usage, layerId, value[1]);
    }
    for (const item of value) {
      scanValue(item, layerId, usage);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const nested of Object.values(record)) {
    scanValue(nested, layerId, usage);
  }
}

/**
 * Reduces an `icon-image` to the names it can produce. A name is a sequence of
 * literals and property lookups, so `"road_{ref_length}"` and
 * `["concat", "road_", ["get", "ref_length"]]` both come back as the same shape
 * and can be completed later from a sampled feature.
 *
 * Harvesting the string literals visible in the expression instead reported an
 * operator name and an empty string as missing icons; see validation/FINDINGS.md.
 */
function collectIconNames(value: unknown, notes?: string[]): IconNamePart[][] {
  if (typeof value === "string") {
    const parts = parseTokens(value);
    return parts.length === 0 ? [] : [parts];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const operator = value[0];

  if (operator === "literal") {
    return Array.isArray(value[1])
      ? value[1]
          .filter((item): item is string => typeof item === "string")
          .map(parseTokens)
          .filter((parts) => parts.length > 0)
      : [];
  }
  if (operator === "image") {
    return collectIconNames(value[1], notes);
  }
  if (operator === "get") {
    return typeof value[1] === "string" ? [[{ property: value[1] }]] : [];
  }
  // A coercion or a fallback passes its arguments through unchanged.
  if (operator === "to-string" || operator === "coalesce") {
    return value.slice(1).flatMap((argument) => collectIconNames(argument, notes));
  }
  if (operator === "concat") {
    return collectConcatNames(value, notes);
  }
  if (operator === "match") {
    return collectMatchNames(value, notes);
  }
  if (operator === "case" || operator === "step") {
    return branchOutputs(value).flatMap((branch) => collectIconNames(branch, notes));
  }
  // Anything else contributes only through its arguments. Index 0 is the
  // operator and is never an icon name.
  return value.slice(1).flatMap((argument) => collectIconNames(argument, notes));
}

/**
 * Enough combinations to cover a realistic `concat` over a couple of branches
 * without letting nested `match` expressions multiply into thousands of names
 * that would each be looked up in the sprite.
 */
const maxIconNameCombinations = 64;

/**
 * `concat` builds one name out of all its arguments in order, so the names it
 * can produce are the combinations of what each argument can produce. Taking
 * only the first alternative of each argument — `collectIconNames(argument)[0]`
 * — silently dropped every branch after the first: `["concat", "prefix-",
 * ["case", …, "one", "two"]]` yielded `prefix-one` alone, and a sprite missing
 * `prefix-two` passed the check.
 *
 * An argument that cannot be reduced, or a product too large to enumerate,
 * makes the whole name unknowable. That is recorded as a note so the sprite
 * check can report it incomplete rather than quietly checking nothing.
 */
function collectConcatNames(value: unknown[], notes?: string[]): IconNamePart[][] {
  let combinations: IconNamePart[][] = [[]];

  for (const argument of value.slice(1)) {
    const alternatives = collectIconNames(argument, notes);
    if (alternatives.length === 0) {
      // A string always reduces to a known fragment; an empty one — `""`, which
      // means "draw no icon" on its own — simply contributes nothing here.
      if (typeof argument === "string") {
        continue;
      }
      notes?.push("an argument that cannot be reduced to a name");
      return [];
    }
    if (combinations.length * alternatives.length > maxIconNameCombinations) {
      notes?.push(`more than ${maxIconNameCombinations} possible names`);
      return [];
    }
    combinations = combinations.flatMap((prefix) =>
      alternatives.map((alternative) => [...prefix, ...alternative])
    );
  }

  return combinations.filter((parts) => parts.length > 0);
}

/**
 * A `match` branch is only reachable when the tested value is one of its labels.
 * When the branch then re-reads the very property the match tested — the common
 * `["match", ["get","subclass"], ["florist"], ["get","subclass"], …]` shape —
 * the names it can produce are exactly those labels, not every value the
 * property takes. Treating it as unconstrained asked the sprite for every POI
 * subclass in the tileset: 405 findings against one production style, all of
 * them names the style would never request.
 */
function collectMatchNames(expression: unknown[], notes?: string[]): IconNamePart[][] {
  const input = expression[1];
  const inputProperty =
    Array.isArray(input) && input[0] === "get" && typeof input[1] === "string"
      ? input[1]
      : undefined;

  const names: IconNamePart[][] = [];
  for (let index = 2; index < expression.length - 1; index += 2) {
    const labels = expression[index];
    const output = expression[index + 1];

    if (
      inputProperty !== undefined &&
      Array.isArray(output) &&
      output[0] === "get" &&
      output[1] === inputProperty
    ) {
      for (const label of Array.isArray(labels) ? labels : [labels]) {
        if (typeof label === "string" && label !== "") {
          names.push([{ literal: label }]);
        }
      }
      continue;
    }
    names.push(...collectIconNames(output, notes));
  }

  // The default branch is whatever the labels did not catch, so nothing
  // constrains it.
  if (expression.length > 2) {
    names.push(...collectIconNames(expression[expression.length - 1], notes));
  }
  return names;
}

/**
 * Splits the legacy `{field}` token syntax, which MapLibre still substitutes
 * from feature properties at render time. An empty string is the idiom for
 * drawing no icon, so it yields no name at all.
 */
function parseTokens(value: string): IconNamePart[] {
  if (value === "") {
    return [];
  }

  const parts: IconNamePart[] = [];
  const token = /\{([^{}]+)\}/g;
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(value)) !== null) {
    if (match.index > consumed) {
      parts.push({ literal: value.slice(consumed, match.index) });
    }
    parts.push({ property: match[1]! });
    consumed = match.index + match[0].length;
  }
  if (consumed < value.length) {
    parts.push({ literal: value.slice(consumed) });
  }
  return parts;
}

function collectStaticStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  // `text-font` takes a bare array of font names as well as an expression, and
  // `["Noto Sans Regular"]` has no operator at index 0 — every element of it is
  // a real name. Only an actual expression gets its operator skipped.
  if (!isExpression(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (value[0] === "literal" && Array.isArray(value[1])) {
    return value[1].filter((item): item is string => typeof item === "string");
  }

  if (value[0] === "image" && typeof value[1] === "string") {
    return [value[1]];
  }

  // Values produced at runtime are not static names, and neither are the branch
  // labels of a decision expression — only its output branches are.
  if (value[0] === "concat" || value[0] === "get" || value[0] === "var") {
    return [];
  }

  if (value[0] === "match" || value[0] === "case" || value[0] === "step") {
    return branchOutputs(value).flatMap(collectStaticStrings);
  }

  // Anything else contributes only through its arguments. Index 0 is the
  // operator: harvesting it asked the glyph endpoint for a font stack named
  // `coalesce`, turning a valid style into an incomplete report.
  return value.slice(1).flatMap(collectStaticStrings);
}

/**
 * Feature properties a layer `filter` reads, and whether the filter can be
 * decided from properties alone. `within` and friends need real geometry, and
 * feature state has no meaning outside a running map, so a filter using them
 * cannot be evaluated against a sampled feature and must not be guessed at.
 */
export function filterInputs(filter: unknown): { properties: Set<string>; evaluable: boolean } {
  const properties = new Set<string>();
  let evaluable = true;

  if (filter === undefined) {
    return { properties, evaluable };
  }

  // Legacy filters name their property bare — `["==", "class", "airport"]` —
  // so they are normalized to expression syntax before anything is read out.
  let normalized: unknown = filter;
  try {
    normalized = convertFilter(filter as FilterSpecification);
  } catch {
    return { properties, evaluable: false };
  }

  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    const operator = value[0];
    if (operator === "get" && typeof value[1] === "string" && value.length === 2) {
      properties.add(value[1]);
      return;
    }
    if (operator === "has" && typeof value[1] === "string" && value.length === 2) {
      properties.add(value[1]);
      return;
    }
    if (typeof operator === "string" && undecidableOperators.has(operator)) {
      evaluable = false;
      return;
    }
    for (const item of value.slice(1)) {
      walk(item);
    }
  };
  walk(normalized);

  return { properties, evaluable };
}

/**
 * Operators whose value cannot be reconstructed from a sampled feature's
 * properties and geometry type.
 */
const undecidableOperators = new Set([
  "within",
  "distance-from-center",
  "feature-state",
  "global-state",
  "accumulated",
  "line-progress",
  "pitch",
  "id",
  "properties"
]);

// `match` alternates label/output from index 2, `case` alternates
// condition/output from index 1, and `step` alternates output/stop from index 2.
// All three end with a default output.
function branchOutputs(expression: unknown[]): unknown[] {
  const firstOutputIndex = expression[0] === "match" ? 3 : 2;
  const outputs: unknown[] = [];

  for (let index = firstOutputIndex; index < expression.length - 1; index += 2) {
    outputs.push(expression[index]);
  }
  if (expression.length > firstOutputIndex) {
    outputs.push(expression[expression.length - 1]);
  }

  return outputs;
}

function addProperty(usage: StyleUsage, layerId: string, property: string): void {
  const existing = usage.properties.get(layerId) ?? new Set<string>();
  existing.add(property);
  usage.properties.set(layerId, existing);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
