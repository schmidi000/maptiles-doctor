import { describe, expect, it } from "vitest";
import { collectStyleUsage, iconTemplateProperties, renderIconName } from "../src/expression.js";

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

    it("abandons a concat whose argument cannot be modelled", () => {
      const usage = collectStyleUsage({
        layers: [
          { id: "a", layout: { "icon-image": ["concat", "pin-", ["number-format", 1, {}]] } }
        ]
      });

      expect([...usage.iconImages]).toEqual([]);
      expect(usage.iconTemplates).toEqual([]);
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
