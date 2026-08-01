import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding, IncompleteCheck } from "@maptiles-doctor/core";
import { indexStyle, locateFinding, locateIncompleteCheck } from "../src/locate.js";

const root = resolve(import.meta.dirname, "../../..");

function styleText(fixture: string): string {
  return readFileSync(resolve(root, `fixtures/${fixture}/style.json`), "utf8");
}

/** The located substring is the assertion: an offset alone proves nothing. */
function located(fixture: string, finding: Partial<Finding>): string | undefined {
  const text = styleText(fixture);
  const span = locateFinding(indexStyle(text), {
    id: "test",
    severity: "broken",
    category: "source-layer",
    message: "test",
    ...finding
  });
  return span ? text.slice(span.offset, span.offset + span.length) : undefined;
}

describe("locateFinding", () => {
  it("points at the source-layer property of the offending layer", () => {
    expect(
      located("broken-style", {
        category: "source-layer",
        layerId: "3d-buildings",
        sourceLayer: "building"
      })
    ).toBe('"source-layer": "building"');
  });

  it("points at the layer's own source reference", () => {
    expect(
      located("broken-style", { category: "source", layerId: "cafes", sourceId: "openmaptiles" })
    ).toBe('"source": "openmaptiles"');
  });

  it("points at a zoom bound", () => {
    expect(located("broken-style", { category: "zoom", layerId: "3d-buildings" })).toBe(
      '"minzoom": 12'
    );
  });

  it("falls back to a later zoom bound when the layer has no minzoom", () => {
    expect(located("broken-style", { category: "zoom", layerId: "cafes" })).toBe('"maxzoom": 14');
  });

  it("points at the expression container that reads the property", () => {
    // A multi-line block is marked by its key; the whole block under a
    // squiggle is noise.
    expect(
      located("broken-style", {
        category: "expression-property",
        layerId: "3d-buildings",
        property: "missing_height"
      })
    ).toBe('"paint"');
  });

  it("points at the layer that references a missing icon", () => {
    expect(located("broken-style", { id: "sprite.icon.cafe.missing", category: "icon" })).toBe(
      '"icon-image": "cafe"'
    );
  });

  it("falls back to the sprite declaration when no layer names the icon", () => {
    expect(located("broken-style", { id: "sprite.icon.unknown.missing", category: "icon" })).toBe(
      '"sprite": "../simple-style/sprite"'
    );
  });

  it("points at the font stack of the offending layer", () => {
    expect(located("glyph-style", { category: "glyph", layerId: "poi-labels-missing-font" })).toBe(
      '"text-font": ["Missing Font Regular"]'
    );
  });

  it("points at the glyphs declaration for a style-wide glyph finding", () => {
    expect(located("glyph-style", { category: "glyph" })).toBe(
      '"glyphs": "./glyphs/{fontstack}/{range}.pbf"'
    );
  });

  it("maps a style-spec error key onto the property it names", () => {
    expect(
      located("invalid-style", {
        category: "style-spec",
        path: "layers[0].paint.fill-color"
      })
    ).toBe('"fill-color": "not-a-color"');
  });

  it("marks a source by its key rather than its whole object", () => {
    expect(located("broken-style", { category: "source", sourceId: "openmaptiles" })).toBe(
      '"openmaptiles"'
    );
  });

  it("falls back to the sources block for an unknown source id", () => {
    expect(located("broken-style", { category: "source", sourceId: "elsewhere" })).toBe(
      '"sources"'
    );
  });

  it("returns nothing when the finding names no style node", () => {
    expect(located("broken-style", { category: "tile-availability" })).toBeUndefined();
  });

  it("returns nothing for an unparsable document", () => {
    expect(
      locateFinding(indexStyle("not json at all"), {
        id: "test",
        severity: "broken",
        category: "glyph",
        message: "test"
      })
    ).toBeUndefined();
  });
});

describe("locateIncompleteCheck", () => {
  function locatedCheck(fixture: string, check: Partial<IncompleteCheck>): string | undefined {
    const text = styleText(fixture);
    const span = locateIncompleteCheck(indexStyle(text), {
      id: "test",
      category: "sprite",
      message: "test",
      ...check
    });
    return span ? text.slice(span.offset, span.offset + span.length) : undefined;
  }

  it("points at the sprite declaration", () => {
    expect(locatedCheck("missing-sprite", { category: "sprite" })).toBe('"sprite": "./sprite"');
  });

  it("points at the glyphs declaration", () => {
    expect(locatedCheck("glyph-style", { category: "glyph" })).toBe(
      '"glyphs": "./glyphs/{fontstack}/{range}.pbf"'
    );
  });

  it("points at the source that could not be read", () => {
    expect(locatedCheck("broken-style", { category: "source", sourceId: "openmaptiles" })).toBe(
      '"openmaptiles"'
    );
  });

  it("returns nothing when the check names no style node", () => {
    expect(locatedCheck("broken-style", { category: "tile-availability" })).toBeUndefined();
  });

  it("returns nothing for an unparsable document", () => {
    expect(
      locateIncompleteCheck(indexStyle("]["), {
        id: "test",
        category: "sprite",
        message: "test"
      })
    ).toBeUndefined();
  });
});
