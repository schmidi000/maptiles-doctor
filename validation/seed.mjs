#!/usr/bin/env node
// Seeds known contract failures into a real production style and measures how
// many the checker catches. This is the release gate in docs/implementation.md:
// "seeded prototype catches at least 8 of 10 intentional contract failures".
//
// Detection is measured as a diff against the unmutated baseline, not as
// "reported something". A style that already has findings would otherwise score
// full marks for noticing nothing.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const cacheDir = join(here, ".cache");
const workDir = join(here, ".seeded");
const cli = join(repoRoot, "packages", "cli", "dist", "index.js");

const args = process.argv.slice(2);
const targetId = valueOf("--target") ?? "openfreemap-liberty";
const timeoutMs = Number(valueOf("--timeout-ms") ?? 30_000);

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Each mutation breaks one contract the checker claims to verify. `applies`
 * keeps a mutation honest about styles it cannot be expressed against, and
 * those are excluded from the denominator and reported, never silently passed.
 */
const mutations = [
  {
    id: "source-layer-renamed",
    category: "source-layer",
    describe: "a layer points at a source-layer the tileset does not contain",
    applies: (style) => findLayer(style, (layer) => typeof layer["source-layer"] === "string"),
    apply: (style, layer) => {
      layer["source-layer"] = `${layer["source-layer"]}_seeded_missing`;
    }
  },
  {
    id: "source-undeclared",
    category: "source",
    describe: "a layer references a source id the style never declares",
    applies: (style) => findLayer(style, (layer) => typeof layer.source === "string"),
    apply: (_style, layer) => {
      layer.source = "seeded-missing-source";
    }
  },
  {
    id: "zoom-below-source",
    category: "zoom",
    describe: "a layer's zoom range ends below the source minzoom",
    // Only expressible against a source that starts above zoom 0. Most basemaps
    // start at 0, which is worth knowing about the zoom check itself.
    applies: (style, contracts) => {
      const entry = Object.entries(style.sources ?? {}).find(
        ([id]) => (contracts[id]?.minzoom ?? 0) > 0
      );
      return entry ? findLayer(style, (layer) => layer.source === entry[0]) : undefined;
    },
    apply: (_style, layer) => {
      layer.minzoom = 0;
      layer.maxzoom = 1;
    }
  },
  {
    id: "static-icon-missing",
    category: "icon",
    describe: "a layer names an icon the sprite does not hold",
    applies: (style) =>
      findLayer(
        style,
        (layer) =>
          typeof layer.layout?.["icon-image"] === "string" &&
          !layer.layout["icon-image"].includes("{")
      ),
    apply: (_style, layer) => {
      layer.layout["icon-image"] = "seeded-missing-icon";
    }
  },
  {
    id: "data-driven-icon-missing",
    category: "icon",
    describe: "a data-driven icon name resolves to icons the sprite does not hold",
    // Must be caught by the sampled-name check. Without this the mutation scores
    // a pass off the static icon check, because wrapping a `match` produces
    // static names from its constrained branches too.
    expect: (item) => item.id.includes("icon-from-data"),
    applies: (style) =>
      findLayer(style, (layer) => {
        const icon = layer.layout?.["icon-image"];
        if (typeof icon === "string") {
          return icon.includes("{");
        }
        if (!Array.isArray(icon)) {
          return false;
        }
        // A `match` mixes static branches in; this must exercise the
        // data-driven path on its own.
        return icon[0] !== "match" && JSON.stringify(icon).includes('["get"');
      }),
    apply: (_style, layer) => {
      layer.layout["icon-image"] = ["concat", "seeded-", layer.layout["icon-image"]];
    }
  },
  {
    id: "expression-property-missing",
    category: "expression-property",
    describe: "a layer reads a feature property the source-layer does not carry",
    applies: (style) =>
      findLayer(
        style,
        (layer) =>
          typeof layer["source-layer"] === "string" && layer.layout?.["text-field"] !== undefined
      ),
    apply: (_style, layer) => {
      layer.layout["text-field"] = ["get", "seeded_missing_property"];
    }
  },
  {
    id: "style-spec-invalid",
    category: "style-spec",
    describe: "the style violates the MapLibre style specification",
    applies: (style) => findLayer(style, () => true),
    apply: (_style, layer) => {
      layer.minzoom = "twelve";
    }
  },
  {
    id: "glyphs-unreachable",
    category: "glyph",
    describe: "the glyph endpoint cannot be reached",
    applies: (style) => (style.glyphs ? {} : undefined),
    apply: (style) => {
      style.glyphs = "https://seeded.invalid/{fontstack}/{range}.pbf";
    }
  },
  {
    id: "sprite-unreachable",
    category: "sprite",
    describe: "the sprite index cannot be reached",
    applies: (style) => (style.sprite ? {} : undefined),
    apply: (style) => {
      style.sprite = "https://seeded.invalid/sprite";
    }
  },
  {
    id: "source-unreachable",
    category: "source",
    describe: "a source's tiles and metadata cannot be reached",
    applies: (style) => {
      const entry = Object.entries(style.sources ?? {}).find(([, source]) => source.url);
      return entry ? { id: entry[0] } : undefined;
    },
    apply: (style, handle) => {
      style.sources[handle.id].url = "https://seeded.invalid/tiles.json";
    }
  }
];

function findLayer(style, predicate) {
  return (style.layers ?? []).find((layer) => {
    try {
      return predicate(layer);
    } catch {
      return false;
    }
  });
}

if (!existsSync(cli)) {
  console.error(`Built CLI not found at ${cli}. Run: npm run build`);
  process.exit(2);
}

const stylePath = join(cacheDir, targetId, "style.json");
if (!existsSync(stylePath)) {
  console.error(`No cached style for ${targetId}. Run: npm run validate:real`);
  process.exit(2);
}

await mkdir(workDir, { recursive: true });
const original = JSON.parse(await readFile(stylePath, "utf8"));

console.log(`Seeding failures into ${targetId}\n`);
const baseline = await check("baseline", original);
console.log(
  `baseline: ${baseline.findings.length} findings, ${baseline.incompleteChecks.length} incomplete\n`
);
const baselineIds = new Set([
  ...baseline.findings.map((item) => item.id),
  ...baseline.incompleteChecks.map((item) => item.id)
]);

const results = [];
for (const mutation of mutations) {
  const style = JSON.parse(JSON.stringify(original));
  // Contracts are only needed to know whether a mutation can be expressed; the
  // baseline report carries enough for that.
  const handle = mutation.applies(style, contractsFrom(baseline));
  if (!handle) {
    results.push({ ...mutation, applicable: false });
    console.log(`SKIP  ${mutation.id}: cannot be expressed against this style`);
    continue;
  }

  mutation.apply(style, handle);
  const report = await check(mutation.id, style);
  const fresh = [
    ...report.findings.map((item) => ({ ...item, kind: "finding" })),
    ...report.incompleteChecks.map((item) => ({ ...item, kind: "incomplete" }))
  ].filter(
    (item) =>
      !baselineIds.has(item.id) &&
      item.category === mutation.category &&
      (mutation.expect ? mutation.expect(item) : true)
  );

  const caught = fresh.length > 0;
  const asFinding = fresh.some((item) => item.kind === "finding");
  results.push({ ...mutation, applicable: true, caught, asFinding, evidence: fresh[0]?.message });
  console.log(
    `${caught ? (asFinding ? "PASS " : "PASS*") : "MISS "} ${mutation.id}: ${fresh[0]?.message ?? "nothing new reported"}`
  );
}

report();

async function check(name, style) {
  // Every corpus style uses absolute URLs for sources, sprites and glyphs, so a
  // mutated copy resolves identically from anywhere on disk.
  const path = join(workDir, `${targetId}.${name}.json`);
  await writeFile(path, JSON.stringify(style, null, 2));
  const output = join(workDir, `${targetId}.${name}.report.json`);
  try {
    await execFileAsync(
      process.execPath,
      [
        cli,
        "check",
        path,
        "--format",
        "json",
        "--output",
        output,
        "--timeout-ms",
        String(timeoutMs)
      ],
      { cwd: repoRoot, timeout: timeoutMs * 6 }
    );
  } catch (error) {
    if (typeof error.code !== "number" || error.code === 2) {
      throw new Error(`CLI failed on ${name}: ${error.stderr ?? error.message}`, { cause: error });
    }
  }
  return JSON.parse(await readFile(output, "utf8"));
}

/** Source zoom ranges as the baseline report observed them. */
function contractsFrom(baselineReport) {
  const contracts = {};
  for (const finding of baselineReport.findings) {
    if (finding.category === "zoom" && finding.sourceId && finding.evidence) {
      contracts[finding.sourceId] = { minzoom: finding.evidence.sourceMin };
    }
  }
  return contracts;
}

function report() {
  const applicable = results.filter((item) => item.applicable);
  const caught = applicable.filter((item) => item.caught);
  const asFinding = applicable.filter((item) => item.asFinding);
  const skipped = results.filter((item) => !item.applicable);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Detected ${caught.length} of ${applicable.length} applicable seeded failures`);
  console.log(`  as findings:        ${asFinding.length}`);
  console.log(`  as incomplete only: ${caught.length - asFinding.length}`);
  if (skipped.length > 0) {
    console.log(
      `  not expressible against this style (excluded): ${skipped.map((item) => item.id).join(", ")}`
    );
  }
  const missed = applicable.filter((item) => !item.caught);
  if (missed.length > 0) {
    console.log(`  MISSED: ${missed.map((item) => item.id).join(", ")}`);
  }
  // The gate is "8 of 10". A style that cannot express 8 of the mutations
  // cannot reach it, and calling that a failure would read as a detection
  // problem when it is a coverage one.
  const verdict =
    applicable.length < 8
      ? `CANNOT BE EVALUATED here: only ${applicable.length} of ${mutations.length} mutations are expressible against this style`
      : caught.length >= 8
        ? "MET"
        : "NOT MET";
  console.log(
    `\nRelease gate is 8 of 10: ${verdict}\n  detection rate on this style: ${caught.length}/${applicable.length}`
  );
  console.log(
    "\nAn incomplete check counts as caught: an unreachable artifact is meant to\n" +
      "report incomplete rather than pass, so surfacing it is the correct behavior."
  );
}
