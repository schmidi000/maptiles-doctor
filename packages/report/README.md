# @maptiles-doctor/report

Renderers that turn a [MapTiles Doctor](https://github.com/schmidi000/maptiles-doctor)
report into something a human or a tool can read. Rendering is kept out of the
check engine, so `@maptiles-doctor/core` never has to know how a report is
displayed.

📖 [Documentation](https://maptiles-doctor.com/)

## Install

```bash
npm install @maptiles-doctor/report
```

Requires Node `24.18.1` or newer.

## Usage

```ts
import { writeFile } from "node:fs/promises";
import { checkStyleContract } from "@maptiles-doctor/core";
import { renderHtmlReport, renderSarif } from "@maptiles-doctor/report";

const report = await checkStyleContract({ stylePath: "style.json" });

await writeFile("report.html", renderHtmlReport(report));
await writeFile("results.sarif", renderSarif(report));
```

## API

| Function                   | Returns                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `renderHtmlReport(report)` | A standalone HTML page — no external assets, no build step. The VS Code extension shows this beside the editor.      |
| `renderSarif(report)`      | SARIF 2.1.0, for GitHub code scanning and any other SARIF consumer. Severities map to `error`, `warning` and `note`. |

Both take a `DoctorReport` from `@maptiles-doctor/core` and return a string.

## License

Apache-2.0
