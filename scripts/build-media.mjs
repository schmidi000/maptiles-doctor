// Renders the screenshots used by the READMEs and the documentation site.
//
// Every image is produced by running the real CLI and photographing its real
// output — the terminal shot is the bytes the CLI actually wrote, ANSI colours
// and all, and the report shot is the HTML `renderHtmlReport` actually emits.
// Nothing here is a mockup, so a screenshot cannot quietly start advertising
// behaviour the tool no longer has. Regenerate with `npm run media:build` after
// changing output formatting.
import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "packages/cli/dist/index.js");
const mediaDir = resolve(root, "site/media");

// The HTML report prints the absolute path of every artifact it read, so a
// screenshot taken in a working copy publishes whatever the maintainer's
// checkout is called. The fixtures are staged somewhere neutral and the demo
// runs from there instead.
const stage = resolve(tmpdir(), "maptiles-doctor-demo");

/** A terminal session: each entry is one command and the output it produced. */
const SESSION = [
  {
    argv: [
      "check",
      "fixtures/broken-style/style.json",
      "--source",
      "openmaptiles=fixtures/simple-style/tilejson.json"
    ]
  },
  {
    argv: [
      "check",
      "fixtures/data-driven-icon/style.json",
      "--source",
      "openmaptiles=fixtures/simple-style/tilejson.json"
    ]
  }
];

async function captureCli(argv) {
  // Colour is normally stripped when stdout is not a TTY, which is exactly the
  // case here. Forcing it keeps the screenshot faithful to an interactive run.
  const { stdout } = await run(process.execPath, [cli, ...argv], {
    cwd: stage,
    env: { ...process.env, FORCE_COLOR: "3" }
  }).catch((error) => {
    // A failing check exits 1 by design; that is the output worth showing.
    if (typeof error.stdout === "string") {
      return error;
    }
    throw error;
  });
  return stdout;
}

const ANSI_COLORS = {
  30: "#4b535f",
  31: "#ff8a80",
  32: "#6fdc9b",
  33: "#ffc46b",
  34: "#7db9ff",
  35: "#d7a8ff",
  36: "#5fd0bd",
  37: "#e6e9ee"
};

/**
 * Turns the SGR sequences chalk emits into spans. Only the subset the CLI uses
 * is handled — basic foreground colours and their reset — and anything else is
 * dropped rather than printed as stray text.
 */
function ansiToHtml(text) {
  let html = "";
  let open = false;
  let index = 0;
  const escaped = (value) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  // Built rather than written as a literal: an ESC in a regex literal is a
  // control character, which `no-control-regex` rejects and a reader cannot see.
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    html += escaped(text.slice(index, match.index));
    index = match.index + match[0].length;
    for (const code of match[1].split(";")) {
      const color = ANSI_COLORS[Number(code)];
      if (color) {
        if (open) {
          html += "</span>";
        }
        html += `<span style="color:${color}">`;
        open = true;
      } else if (code === "39" || code === "0" || code === "") {
        if (open) {
          html += "</span>";
          open = false;
        }
      }
    }
  }
  html += escaped(text.slice(index));
  return open ? `${html}</span>` : html;
}

function terminalPage(blocks) {
  const body = blocks
    .map(
      (block) =>
        `<div class="cmd"><span class="prompt">$</span> ${block.command}</div>` +
        `<div class="out">${block.output}</div>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d11; padding: 28px; }
  .window { background: #12151a; border: 1px solid #262c35; border-radius: 10px; overflow: hidden; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 11px 14px; background: #171b22; border-bottom: 1px solid #262c35; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .title { margin-left: 8px; color: #6d7683; font: 12px system-ui, sans-serif; }
  .body { padding: 16px 18px 18px; }
  .cmd, .out { font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .cmd { color: #e6e9ee; margin-top: 14px; }
  .cmd:first-child { margin-top: 0; }
  .prompt { color: #5fd0bd; user-select: none; }
  .out { color: #b6bec9; }
</style></head><body>
  <div class="window">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">maptiles-doctor</span>
    </div>
    <div class="body">${body}</div>
  </div>
</body></html>`;
}

async function shoot(browser, html, outfile, width) {
  const page = await browser.newPage({
    viewport: { width, height: 600 },
    deviceScaleFactor: 2
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: outfile, fullPage: true });
  await page.close();
  return outfile;
}

export async function buildMedia() {
  const { chromium } = await import("playwright");
  await mkdir(mediaDir, { recursive: true });

  // `fixtures/generated` has to come along: the data-driven icon demo only says
  // anything interesting because it samples real tiles.
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(resolve(root, "fixtures"), resolve(stage, "fixtures"), { recursive: true });

  const blocks = [];
  for (const step of SESSION) {
    blocks.push({
      command: `maptiles-doctor ${step.argv.join(" ")}`,
      output: ansiToHtml(await captureCli(step.argv))
    });
  }

  const reportHtml = await captureCli([
    "check",
    "fixtures/broken-style/style.json",
    "--source",
    "openmaptiles=fixtures/simple-style/tilejson.json",
    "--format",
    "html"
  ]);

  const browser = await chromium.launch();
  const written = [];
  try {
    written.push(await shoot(browser, terminalPage(blocks), resolve(mediaDir, "cli.png"), 900));
    written.push(await shoot(browser, reportHtml, resolve(mediaDir, "report.png"), 900));
  } finally {
    await browser.close();
    await rm(stage, { recursive: true, force: true });
  }

  // A plain-text copy of the same session, for anywhere an image is the wrong
  // answer: a screen reader, a terminal, a diff.
  await writeFile(
    resolve(mediaDir, "cli.txt"),
    blocks.map((block) => `$ ${block.command}\n${stripAnsi(block.output)}`).join("\n")
  );

  return written;
}

function stripAnsi(html) {
  return html
    .replaceAll(/<\/?span[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const written = await buildMedia();
  for (const file of written) {
    console.log(`Wrote ${file}`);
  }
}
