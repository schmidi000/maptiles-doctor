// Copies the single root LICENSE into every workspace package.
//
// npm only ships a license file that sits inside the package directory, and a
// monorepo keeps one copy at the root. The copies are generated rather than
// committed so there is exactly one file to edit, and they are gitignored.
import { copyFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function syncLicense() {
  const source = resolve(root, "LICENSE");
  const packagesDir = resolve(root, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const written = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const target = resolve(packagesDir, entry.name, "LICENSE");
    await copyFile(source, target);
    written.push(target);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const written = await syncLicense();
  console.log(`Copied LICENSE into ${written.length} package(s).`);
}
