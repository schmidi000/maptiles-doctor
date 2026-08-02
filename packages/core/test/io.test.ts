import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsLocalFile,
  hashLocalFile,
  headOrGetOk,
  isHttpUrl,
  locationDir,
  readRemoteBytes,
  readText,
  resolveLocation
} from "../src/io.js";

describe("resolveLocation", () => {
  it("leaves an absolute URL alone", () => {
    expect(resolveLocation("https://host/a.json", "/base")).toBe("https://host/a.json");
  });

  // `node:path` would turn a relative reference under a remote style into a path
  // inside the working directory, and the artifact would never be requested.
  it("resolves a relative reference against a remote base as a URL", () => {
    expect(resolveLocation("./tilejson.json", "https://host/styles/")).toBe(
      "https://host/styles/tilejson.json"
    );
    expect(resolveLocation("../../sprite", "https://host/styles/basemap/")).toBe(
      "https://host/sprite"
    );
  });

  // No tile server substitutes percent-encoded braces, so a template resolved
  // through `new URL` has to come back out unencoded.
  it("keeps tile template placeholders unencoded", () => {
    expect(resolveLocation("../tiles/{z}/{x}/{y}.pbf", "https://host/meta/")).toBe(
      "https://host/tiles/{z}/{x}/{y}.pbf"
    );
    expect(resolveLocation("{fontstack}/{range}.pbf", "https://host/fonts/")).toBe(
      "https://host/fonts/{fontstack}/{range}.pbf"
    );
  });

  it("resolves a relative path against a local base", () => {
    expect(resolveLocation("tilejson.json", "/base/style")).toBe("/base/style/tilejson.json");
    expect(resolveLocation("/absolute.json", "/base")).toBe("/absolute.json");
  });
});

describe("locationDir", () => {
  // `dirname` collapses `https://` to `https:/`, which makes every reference
  // under it resolve against the wrong origin.
  it("returns the parent URL of a remote artifact", () => {
    expect(locationDir("https://host/styles/basemap/style.json")).toBe(
      "https://host/styles/basemap/"
    );
  });

  it("drops the query and fragment, which are not part of the base", () => {
    expect(locationDir("https://host/styles/style.json?token=abc#v2")).toBe("https://host/styles/");
  });

  it("returns the parent directory of a path", () => {
    expect(locationDir("/base/style/style.json")).toBe("/base/style");
  });
});

describe("isHttpUrl", () => {
  it.each([
    ["https://host/a", true],
    ["http://host/a", true],
    ["/local/path", false],
    ["./relative", false],
    ["pmtiles://host/a.pmtiles", false],
    ["file:///a", false]
  ])("classifies %s as %s", (location, expected) => {
    expect(isHttpUrl(location)).toBe(expected);
  });
});

describe("local file helpers", () => {
  let dir = "";
  let present = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "maptiles-doctor-io-"));
    present = join(dir, "present.json");
    await writeFile(present, "{}");
  });

  it("reports whether a local file exists", async () => {
    expect(await existsLocalFile(present)).toBe(true);
    expect(await existsLocalFile(join(dir, "absent.json"))).toBe(false);
  });

  // A remote artifact is never "present on disk", and answering yes would
  // attribute a hash and an existence claim to something never read.
  it("treats a remote location as neither present nor hashable", async () => {
    expect(await existsLocalFile("https://host/a.json")).toBe(false);
    expect(await hashLocalFile("https://host/a.json")).toBeUndefined();
  });

  it("hashes a local file reproducibly", async () => {
    const hash = await hashLocalFile(present);

    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await hashLocalFile(present)).toBe(hash);
  });
});

describe("remote reads", () => {
  let server: Server;
  let origin = "";
  let redirectHops = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/ok.json") {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      if (url.pathname === "/bytes") {
        response.writeHead(200).end(Buffer.from([1, 2, 3]));
        return;
      }
      if (url.pathname === "/missing") {
        response.writeHead(404).end();
        return;
      }
      if (url.pathname === "/empty") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/broken") {
        response.writeHead(500).end();
        return;
      }
      if (url.pathname === "/redirect-once") {
        response.writeHead(302, { location: "/ok.json" }).end();
        return;
      }
      if (url.pathname === "/redirect-to-missing") {
        response.writeHead(302, { location: "/missing" }).end();
        return;
      }
      if (url.pathname === "/redirect-loop") {
        redirectHops += 1;
        response.writeHead(302, { location: "/redirect-loop" }).end();
        return;
      }
      if (url.pathname === "/no-head") {
        // Some CDNs answer HEAD with 405 but serve the GET perfectly well.
        response.writeHead(request.method === "HEAD" ? 405 : 200).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  describe("readRemoteBytes", () => {
    it("returns the body of a successful response", async () => {
      expect(await readRemoteBytes(`${origin}/bytes`, 5_000)).toEqual(new Uint8Array([1, 2, 3]));
    });

    // The distinction the whole report model rests on: an artifact that is
    // absent is a finding, one that could not be reached is an incomplete check.
    // Collapsing them would either invent breakage or hide it.
    it.each(["/missing", "/empty"])(
      "reports %s as absent rather than unreachable",
      async (path) => {
        expect(await readRemoteBytes(`${origin}${path}`, 5_000)).toBeUndefined();
      }
    );

    it("throws for a server error, which is unreachable rather than absent", async () => {
      await expect(readRemoteBytes(`${origin}/broken`, 5_000)).rejects.toThrow("HTTP 500");
    });

    it("follows a redirect to the artifact", async () => {
      expect(await readRemoteBytes(`${origin}/redirect-once`, 5_000)).toBeDefined();
    });
  });

  describe("readText", () => {
    it("reads a remote document through a redirect", async () => {
      expect(await readText(`${origin}/redirect-once`, 5_000)).toBe('{"ok":true}');
    });

    it("throws for a non-2xx response", async () => {
      await expect(readText(`${origin}/missing`, 5_000)).rejects.toThrow("HTTP 404");
    });

    it("gives up on a redirect loop instead of following it forever", async () => {
      redirectHops = 0;
      await expect(readText(`${origin}/redirect-loop`, 5_000)).rejects.toThrow();
      // Bounded, and low enough that a loop cannot stall a check.
      expect(redirectHops).toBeLessThanOrEqual(6);
    });
  });

  describe("headOrGetOk", () => {
    it("accepts an artifact that answers HEAD", async () => {
      expect(await headOrGetOk(`${origin}/ok.json`, 5_000)).toBe(true);
    });

    it("falls back to GET when HEAD is not allowed", async () => {
      expect(await headOrGetOk(`${origin}/no-head`, 5_000)).toBe(true);
    });

    it("rejects an artifact that is absent by both methods", async () => {
      expect(await headOrGetOk(`${origin}/missing`, 5_000)).toBe(false);
    });

    it("follows a redirect rather than counting it as reachable on its own", async () => {
      expect(await headOrGetOk(`${origin}/redirect-once`, 5_000)).toBe(true);
      // The redirect answered, but what it pointed at did not exist. Accepting
      // any 3xx without looking counted this as a healthy artifact.
      expect(await headOrGetOk(`${origin}/redirect-to-missing`, 5_000)).toBe(false);
    });

    it("checks the filesystem for a local path", async () => {
      const dir = await mkdtemp(join(tmpdir(), "maptiles-doctor-head-"));
      const path = join(dir, "sprite.json");
      await writeFile(path, "{}");

      expect(await headOrGetOk(path, 5_000)).toBe(true);
      expect(await headOrGetOk(join(dir, "absent.json"), 5_000)).toBe(false);
    });
  });
});
