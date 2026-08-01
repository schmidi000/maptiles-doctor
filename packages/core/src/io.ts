import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { request } from "undici";

export function resolveLocation(location: string, baseDir = process.cwd()): string {
  if (isHttpUrl(location)) {
    return location;
  }
  return isAbsolute(location) ? location : resolve(baseDir, location);
}

export function isHttpUrl(location: string): boolean {
  return location.startsWith("http://") || location.startsWith("https://");
}

export async function readText(location: string, timeoutMs: number): Promise<string> {
  if (isHttpUrl(location)) {
    const response = await request(location, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}`);
    }
    return response.body.text();
  }
  return readFile(location, "utf8");
}

export async function readJson<T = unknown>(location: string, timeoutMs: number): Promise<T> {
  return JSON.parse(await readText(location, timeoutMs)) as T;
}

/** Returns undefined when the resource is absent rather than unreachable. */
export async function readRemoteBytes(
  location: string,
  timeoutMs: number
): Promise<Uint8Array | undefined> {
  const response = await request(location, {
    method: "GET",
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });

  if (response.statusCode === 404 || response.statusCode === 204) {
    await response.body.dump();
    return undefined;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.dump();
    throw new Error(`HTTP ${response.statusCode}`);
  }

  return new Uint8Array(await response.body.arrayBuffer());
}

export async function hashLocalFile(location: string): Promise<string | undefined> {
  if (isHttpUrl(location)) {
    return undefined;
  }
  const buffer = await readFile(location);
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export async function existsLocalFile(location: string): Promise<boolean> {
  if (isHttpUrl(location)) {
    return false;
  }
  try {
    await stat(location);
    return true;
  } catch {
    return false;
  }
}

export async function headOrGetOk(location: string, timeoutMs: number): Promise<boolean> {
  if (!isHttpUrl(location)) {
    return existsLocalFile(location);
  }

  const head = await request(location, {
    method: "HEAD",
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });

  // `dump()` discards the body without the abort error that destroying an
  // unconsumed undici stream raises.
  await head.body.dump();
  if (head.statusCode >= 200 && head.statusCode < 400) {
    return true;
  }

  const get = await request(location, {
    method: "GET",
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  await get.body.dump();
  return get.statusCode >= 200 && get.statusCode < 400;
}
