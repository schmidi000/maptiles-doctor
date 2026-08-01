import { describe, expect, it } from "vitest";
import {
  collectStyleUsage,
  filterInputs,
  iconTemplateProperties,
  renderIconName
} from "../src/expression.js";

describe("collectStyleUsage", () => {
  it("collects static icon names from strings, image expressions, and match branches", () => {
    const usage = collectStyleUsage({
      layers: [
        { id: "a", layout: { "icon-image": "marker" } },
        { id: "b", layout: { "icon-image": ["image", "cafe"] } },
        {
          id: "c",
          layout: {
            "icon-image": ["match", ["get", "class"], "park", "tree", "default-pin"]
          }
        }
      ]
    });

    // "park" is a match label, not an icon name, and neither is the operator.
    expect([...usage.iconImages].sort()).toEqual(["cafe", "default-pin", "marker", "tree"]);
  });

  it("collects only the output branches of case and step icon expressions", () => {
    const usage = collectStyleUsage({
      layers: [
        {
          id: "a",
          layout: {
            "icon-image": ["case", [">", ["get", "rank"], 3], "major-pin", "minor-pin"]
          }
        },
        { id: "b", layout: { "icon-image": ["step", ["zoom"], "small-pin", 12, "large-pin"] } }
      ]
    });

    expect([...usage.iconImages].sort()).toEqual([
      "large-pin",
      "major-pin",
      "minor-pin",
      "small-pin"
    ]);
  });

  it("keeps icon names built at runtime out of the static set", () => {
    const usage = collectStyleUsage({
      layers: [
        { id: "a", layout: { "icon-image": ["concat", ["get", "class"], "-icon"] } },
        { id: "b", layout: { "icon-image": ["get", "icon_name"] } }
      ]
    });

    expect([...usage.iconImages]).toEqual([]);
  });

  // Harvesting whatever string literals were visible reported an operator name
  // and an empty string as missing icons; see validation/FINDINGS.md.
  it("does not mistake an operator name for an icon", () => {
    const usage = collectStyleUsage({
      layers: [{ id: "a", layout: { "icon-image": ["to-string", ["get", "class"]] } }]
    });

    expect([...usage.iconImages]).toEqual([]);
    expect(usage.iconTemplates).toEqual([{ layerId: "a", parts: [{ property: "class" }] }]);
  });

  it("does not treat the empty string as an icon name", () => {
    const usage = collectStyleUsage({
      layers: [{ id: "a", layout: { "icon-image": ["step", ["zoom"], "circle", 10, ""] } }]
    });

    expect([...usage.iconImages]).toEqual(["circle"]);
    expect(usage.iconTemplates).toEqual([]);
  });

  describe("data-driven names", () => {
    it("models the legacy {token} syntax as literals and property lookups", () => {
      const usage = collectStyleUsage({
        layers: [{ id: "shields", layout: { "icon-image": "road_{ref_length}" } }]
      });

      expect([...usage.iconImages]).toEqual([]);
      expect(usage.iconTemplates).toEqual([
        {
          layerId: "shields",
          parts: [{ literal: "road_" }, { property: "ref_length" }]
        }
      ]);
    });

    it("models concat the same way, so both spellings check identically", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "shields",
            layout: { "icon-image": ["concat", ["get", "network"], "_", ["get", "ref_length"]] }
          }
        ]
      });

      expect(usage.iconTemplates).toEqual([
        {
          layerId: "shields",
          parts: [{ property: "network" }, { literal: "_" }, { property: "ref_length" }]
        }
      ]);
    });

    it("treats a match with a data-driven branch as one static and one template", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "poi",
            layout: {
              "icon-image": ["match", ["get", "subclass"], ["florist"], "flower", ["get", "class"]]
            }
          }
        ]
      });

      expect([...usage.iconImages]).toEqual(["flower"]);
      expect(usage.iconTemplates).toEqual([{ layerId: "poi", parts: [{ property: "class" }] }]);
    });

    // A branch that re-reads the property the match tested can only produce the
    // labels that selected it. Treating it as unconstrained asked the sprite for
    // every POI subclass in the tileset; see validation/FINDINGS.md.
    it("constrains a branch that re-reads the matched property to its labels", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "poi",
            layout: {
              "icon-image": [
                "match",
                ["get", "subclass"],
                ["florist", "furniture"],
                ["get", "subclass"],
                ["get", "class"]
              ]
            }
          }
        ]
      });

      expect([...usage.iconImages].sort()).toEqual(["florist", "furniture"]);
      // Only the default branch stays data-driven.
      expect(usage.iconTemplates).toEqual([{ layerId: "poi", parts: [{ property: "class" }] }]);
    });

    it("leaves a branch reading a different property data-driven", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "poi",
            layout: {
              "icon-image": ["match", ["get", "class"], ["shop"], ["get", "subclass"], "pin"]
            }
          }
        ]
      });

      expect([...usage.iconImages]).toEqual(["pin"]);
      expect(usage.iconTemplates).toEqual([{ layerId: "poi", parts: [{ property: "subclass" }] }]);
    });

    it("abandons a concat whose argument cannot be modelled, and says so", () => {
      const usage = collectStyleUsage({
        layers: [
          { id: "a", layout: { "icon-image": ["concat", "pin-", ["number-format", 1, {}]] } }
        ]
      });

      expect([...usage.iconImages]).toEqual([]);
      expect(usage.iconTemplates).toEqual([]);
      // Not silently: a layer whose icons were never looked up has to reach the
      // report as an incomplete check rather than as a clean pass.
      expect(usage.unresolvedIcons).toEqual([
        { layerId: "a", reason: "an argument that cannot be reduced to a name" }
      ]);
    });

    // Reading only the first possible output of each argument dropped every
    // branch after the first: a missing `prefix-two` sprite passed the check.
    it("expands every branch of a concat argument", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "a",
            layout: { "icon-image": ["concat", "prefix-", ["case", ["get", "flag"], "one", "two"]] }
          }
        ]
      });

      expect([...usage.iconImages].sort()).toEqual(["prefix-one", "prefix-two"]);
      expect(usage.unresolvedIcons).toEqual([]);
    });

    it("expands the product of several branching concat arguments", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "a",
            layout: {
              "icon-image": [
                "concat",
                ["case", ["get", "f"], "a", "b"],
                "-",
                ["match", ["get", "g"], "x", "one", "two"]
              ]
            }
          }
        ]
      });

      expect([...usage.iconImages].sort()).toEqual(["a-one", "a-two", "b-one", "b-two"]);
    });

    it("keeps a branching concat over a property as one template per branch", () => {
      const usage = collectStyleUsage({
        layers: [
          {
            id: "a",
            layout: {
              "icon-image": ["concat", ["case", ["get", "f"], "road-", "rail-"], ["get", "class"]]
            }
          }
        ]
      });

      expect(usage.iconTemplates).toEqual([
        { layerId: "a", parts: [{ literal: "road-" }, { property: "class" }] },
        { layerId: "a", parts: [{ literal: "rail-" }, { property: "class" }] }
      ]);
    });

    // An empty string means "draw no icon" on its own, but inside a concat it is
    // simply a fragment that contributes nothing — not an unmodellable argument.
    it("treats an empty string argument as an empty fragment", () => {
      const usage = collectStyleUsage({
        layers: [{ id: "a", layout: { "icon-image": ["concat", "pin", ""] } }]
      });

      expect([...usage.iconImages]).toEqual(["pin"]);
      expect(usage.unresolvedIcons).toEqual([]);
    });

    it("gives up on a concat with more names than it will enumerate", () => {
      const many = (prefix: string): unknown[] => [
        "match",
        ["get", "class"],
        ...Array.from({ length: 10 }, (_, index) => [`l${index}`, `${prefix}${index}`]).flat(),
        `${prefix}-default`
      ];
      const usage = collectStyleUsage({
        layers: [{ id: "a", layout: { "icon-image": ["concat", many("a"), many("b")] } }]
      });

      expect([...usage.iconImages]).toEqual([]);
      expect(usage.unresolvedIcons).toEqual([
        { layerId: "a", reason: "more than 64 possible names" }
      ]);
    });

    it("reports every property a template reads", () => {
      const usage = collectStyleUsage({
        layers: [
          { id: "a", layout: { "icon-image": "road_{ref_length}" } },
          { id: "b", layout: { "icon-image": ["get", "class"] } }
        ]
      });

      expect([...iconTemplateProperties(usage.iconTemplates)].sort()).toEqual([
        "class",
        "ref_length"
      ]);
    });
  });

  describe("renderIconName", () => {
    it("substitutes a sampled feature's values", () => {
      expect(
        renderIconName([{ literal: "road_" }, { property: "ref_length" }], { ref_length: "3" })
      ).toBe("road_3");
    });

    it("returns nothing when the feature lacks a property the name needs", () => {
      expect(renderIconName([{ property: "brand" }], { class: "cafe" })).toBeUndefined();
    });

    it("returns nothing when the values render an empty name", () => {
      expect(renderIconName([{ property: "class" }], { class: "" })).toBeUndefined();
    });
  });

  it("collects font stacks from arrays and literal expressions", () => {
    const usage = collectStyleUsage({
      layers: [
        { id: "a", layout: { "text-font": ["Noto Sans Regular"] } },
        { id: "b", layout: { "text-font": ["literal", ["Noto Sans Italic", "Arial Unicode MS"]] } }
      ]
    });

    expect([...usage.fontStacks].sort()).toEqual([
      "Arial Unicode MS",
      "Noto Sans Italic",
      "Noto Sans Regular"
    ]);
  });

  // The fallback treated every string in an unhandled expression as a name,
  // index 0 included, so a valid style asked the glyph endpoint for a font
  // called `coalesce` and came back incomplete.
  it("does not mistake an expression operator for a font stack", () => {
    const usage = collectStyleUsage({
      layers: [
        {
          id: "a",
          layout: {
            "text-font": ["coalesce", ["get", "font"], ["literal", ["Noto Sans Regular"]]]
          }
        }
      ]
    });

    expect([...usage.fontStacks]).toEqual(["Noto Sans Regular"]);
  });

  it("keeps every name of a bare font-stack array, which has no operator", () => {
    const usage = collectStyleUsage({
      layers: [{ id: "a", layout: { "text-font": ["Noto Sans Regular", "Arial Unicode MS"] } }]
    });

    expect([...usage.fontStacks].sort()).toEqual(["Arial Unicode MS", "Noto Sans Regular"]);
  });

  it("reads only the output branches of a decision expression", () => {
    const usage = collectStyleUsage({
      layers: [
        {
          id: "a",
          layout: {
            "text-font": [
              "case",
              ["==", ["get", "class"], "major"],
              ["literal", ["Bold Font Regular"]],
              ["literal", ["Plain Font Regular"]]
            ]
          }
        }
      ]
    });

    expect([...usage.fontStacks].sort()).toEqual(["Bold Font Regular", "Plain Font Regular"]);
  });

  it("collects properties per layer from filters, layout, and nested paint expressions", () => {
    const usage = collectStyleUsage({
      layers: [
        {
          id: "buildings",
          filter: ["==", ["get", "class"], "residential"],
          paint: {
            "fill-color": ["case", [">", ["get", "height"], 20], "#888888", "#cccccc"]
          }
        },
        {
          id: "labels",
          layout: { "text-field": ["get", "name"] }
        }
      ]
    });

    expect([...(usage.properties.get("buildings") ?? [])].sort()).toEqual(["class", "height"]);
    expect([...(usage.properties.get("labels") ?? [])]).toEqual(["name"]);
  });

  it("returns empty usage for a style without layers", () => {
    const usage = collectStyleUsage({ version: 8 });

    expect(usage.iconImages.size).toBe(0);
    expect(usage.fontStacks.size).toBe(0);
    expect(usage.properties.size).toBe(0);
  });
});

// The properties a filter reads decide what tile sampling has to retain, and
// whether a filter can be answered from a sampled feature at all.
describe("filterInputs", () => {
  it("reads the properties of an expression filter", () => {
    const { properties, evaluable } = filterInputs([
      "all",
      ["<=", ["get", "ref_length"], 6],
      ["match", ["get", "network"], ["us-interstate"], true, false]
    ]);

    expect([...properties].sort()).toEqual(["network", "ref_length"]);
    expect(evaluable).toBe(true);
  });

  it("reads the bare property name of a legacy filter", () => {
    const { properties, evaluable } = filterInputs(["all", ["==", "class", "airport"], ["has", "rank"]]);

    expect([...properties].sort()).toEqual(["class", "rank"]);
    expect(evaluable).toBe(true);
  });

  it("needs nothing from a filter that only tests geometry type", () => {
    const { properties, evaluable } = filterInputs(["==", ["geometry-type"], "Polygon"]);

    expect([...properties]).toEqual([]);
    expect(evaluable).toBe(true);
  });

  it("refuses a filter that cannot be answered from a sampled feature", () => {
    expect(filterInputs(["within", { type: "Polygon", coordinates: [] }]).evaluable).toBe(false);
    expect(filterInputs(["==", ["feature-state", "hover"], true]).evaluable).toBe(false);
  });

  it("treats an absent filter as admitting everything", () => {
    const { properties, evaluable } = filterInputs(undefined);

    expect([...properties]).toEqual([]);
    expect(evaluable).toBe(true);
  });
});
