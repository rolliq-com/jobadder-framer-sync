import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fallbackSource from "../framer/JobsFallback.tsx?raw";
import postingSource from "../framer/JobPosting.tsx?raw";
import type { Env } from "../src/config";
import { FALLBACK_JOB_FIELDS, JOBS_CACHE_SECONDS, JOBS_PATH, type FallbackBody } from "../src/fallback";
import { handleRequest } from "../src/index";
import { CAPTURE_KEY } from "../src/store";
import { basicAuth, FEED_URL, FEED_XML, JOBS_XML, PASS, PATH_SECRET, USER } from "./fixtures";

const bindings = env as unknown as { FEED_CAPTURE: KVNamespace; FEED_CAPTURE_R2: R2Bucket };
const SITE = "https://www.example.com";
const HOST = "https://feed.example.test";
const JOBS_URL = HOST + JOBS_PATH;

function fallbackEnv(overrides: Partial<Env> = {}): Env {
  return {
    FEED_MODE: "capture",
    FEED_AUTH_MODE: "basic",
    FEED_BASIC_AUTH_USER: USER,
    FEED_BASIC_AUTH_PASS: PASS,
    CAPTURE_STORE: "kv",
    CAPTURE_BINDING: "FEED_CAPTURE",
    FEED_CAPTURE: bindings.FEED_CAPTURE,
    FEED_CAPTURE_R2: bindings.FEED_CAPTURE_R2,
    JOBS_FALLBACK: "on",
    SITE_ORIGIN: SITE,
    ...overrides,
  };
}

function push(xml: string, e: Env, url = FEED_URL) {
  const headers = { "Content-Type": "application/xml", Authorization: basicAuth(USER, PASS) };
  return handleRequest(new Request(url, { method: "POST", headers, body: xml }), e);
}

function get(e: Env, init: { url?: string; method?: string } = {}) {
  return handleRequest(new Request(init.url ?? JOBS_URL, { method: init.method ?? "GET" }), e);
}

let logSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await caches.default.delete(new Request(JOBS_URL));
  await bindings.FEED_CAPTURE.delete(CAPTURE_KEY);
  await bindings.FEED_CAPTURE_R2.delete(CAPTURE_KEY);
});

function logged(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(" ")).join("\n");
}
function lastLog(): Record<string, unknown> {
  const calls = [...logSpy.mock.calls, ...errSpy.mock.calls];
  return JSON.parse(String(calls.at(-1)![0]));
}

describe("jobs fallback off (the default)", () => {
  it.each([
    ["unset", undefined],
    ["off", "off"],
    ["anything but on", "yes"],
  ])("with JOBS_FALLBACK %s, GET /jobs.json takes the feed path unchanged", async (_name, value) => {
    await push(JOBS_XML, fallbackEnv());
    const basic = await get(fallbackEnv({ JOBS_FALLBACK: value }));
    expect(basic.status).toBe(404);
    expect(await basic.text()).toBe("not found");

    const path = await get(
      fallbackEnv({ JOBS_FALLBACK: value, FEED_AUTH_MODE: "path", FEED_PATH_SECRET: PATH_SECRET }),
    );
    expect(path.status).toBe(404);
    expect(logged()).not.toContain("jobs_request");
  });
});

describe("jobs fallback on", () => {
  it("serves the latest push as JSON, restricted to the site origin", async () => {
    expect((await push(JOBS_XML, fallbackEnv())).status).toBe(200);
    const res = await get(fallbackEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${JOBS_CACHE_SECONDS}`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const text = await res.text();
    const body = JSON.parse(text) as FallbackBody;
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.jobs.map((j) => j.id)).toEqual(["2000001", "2000002", "2000003", "2000004", "2000005", "2000006"]);
    expect(body.jobs[0]).toEqual({
      id: "2000001",
      slug: "senior-example-engineer-2000001",
      title: "Senior Example Engineer",
      summary: "Lead a synthetic team on invented projects.",
      highlights: expect.arrayContaining(["First point"]),
      category: expect.any(String),
      subCategory: expect.any(String),
      location: expect.any(String),
      workType: expect.any(String),
      datePosted: "2026-10-01",
      featured: true,
      applyUrl: "https://apply.example.com/2000001",
    });
    for (const job of body.jobs) expect(Object.keys(job)).toEqual([...FALLBACK_JOB_FIELDS]);
    expect(body.jobs[5]!.title).toBe("Graduate <Trainee>");
  });

  it("never carries an applications address, description HTML or salary", async () => {
    await push(JOBS_XML, fallbackEnv());
    const text = await (await get(fallbackEnv())).text();
    expect(text).not.toMatch(/@example\.com|EmailTo|mailto/i);
    expect(text).not.toMatch(/<p>|<strong>|<ul>/);
    expect(text).not.toMatch(/"salary\w*":|Competitive|90000|\$90k/i);
  });

  it("answers HEAD with headers and no body", async () => {
    await push(FEED_XML, fallbackEnv());
    const res = await get(fallbackEnv(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(await res.text()).toBe("");
  });

  it("answers a CORS preflight with 204", async () => {
    const res = await get(fallbackEnv(), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
  });

  it("serves from the R2 store", async () => {
    const e = fallbackEnv({ CAPTURE_STORE: "r2", CAPTURE_BINDING: "FEED_CAPTURE_R2" });
    await push(JOBS_XML, e);
    const body = (await (await get(e)).json()) as FallbackBody;
    expect(body.jobs).toHaveLength(6);
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("serves an empty list for an empty board", async () => {
    await push("<Jobs/>", fallbackEnv());
    const body = (await (await get(fallbackEnv())).json()) as FallbackBody;
    expect(body.jobs).toEqual([]);
  });

  it("caches the list, so a new push shows once the cached copy expires", async () => {
    await push(FEED_XML, fallbackEnv());
    expect(((await (await get(fallbackEnv())).json()) as FallbackBody).jobs).toHaveLength(1);
    expect(lastLog()).toMatchObject({ event: "jobs_request", outcome: "served", cache: "miss", jobs: 1 });

    await push(JOBS_XML, fallbackEnv());
    // A query string does not create a second cache entry.
    const hit = await get(fallbackEnv(), { url: JOBS_URL + "?x=1" });
    expect(((await hit.json()) as FallbackBody).jobs).toHaveLength(1);
    expect(lastLog()).toMatchObject({ outcome: "served", cache: "hit" });

    await caches.default.delete(new Request(JOBS_URL));
    expect(((await (await get(fallbackEnv())).json()) as FallbackBody).jobs).toHaveLength(6);
  });

  it("answers 503 before the first push, and caches nothing", async () => {
    const res = await get(fallbackEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(lastLog()).toMatchObject({ event: "jobs_request", outcome: "error", reason: "no_capture" });
    expect(await caches.default.match(new Request(JOBS_URL))).toBeUndefined();
  });

  it("answers 503 when the stored push is not a jobs feed", async () => {
    await push("<Other><a/></Other>", fallbackEnv());
    const res = await get(fallbackEnv());
    expect(res.status).toBe(503);
    expect(lastLog()).toMatchObject({ outcome: "error", reason: "not_jobs_root" });
  });

  it("refuses plain HTTP with 403 and no redirect", async () => {
    const res = await get(fallbackEnv(), { url: "http://feed.example.test/jobs.json" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("logs counts and reason codes only, never job text", async () => {
    await push(JOBS_XML, fallbackEnv());
    await get(fallbackEnv());
    const line = lastLog();
    expect(Object.keys(line).sort()).toEqual(["cache", "event", "jobs", "ms", "outcome", "status"]);
    expect(logged()).not.toMatch(/Engineer|apply\.example|example\.com\/2000/);
  });
});

describe("the feed path is unchanged with the fallback on", () => {
  it("still takes POST to /jobs.json through feed auth", async () => {
    const res = await push(FEED_XML, fallbackEnv(), JOBS_URL);
    expect(res.status).toBe(404);
    expect(lastLog()).toMatchObject({ event: "feed_request", reason: "wrong_path" });
  });

  it("still accepts the feed in path mode", async () => {
    const e = fallbackEnv({ FEED_AUTH_MODE: "path", FEED_PATH_SECRET: PATH_SECRET });
    const res = await handleRequest(
      new Request(`${HOST}/${PATH_SECRET}`, { method: "POST", headers: { "Content-Type": "application/xml" }, body: JOBS_XML }),
      e,
    );
    expect(res.status).toBe(200);
    expect(((await (await get(e)).json()) as FallbackBody).jobs).toHaveLength(6);
  });

  it.each([
    ["missing", undefined],
    ["not https", "http://www.example.com"],
    ["with a path", "https://www.example.com/jobs"],
    ["with a trailing slash", "https://www.example.com/"],
    ["a wildcard", "*"],
  ])("a %s SITE_ORIGIN fails the fallback closed but not the feed", async (_name, origin) => {
    const e = fallbackEnv({ SITE_ORIGIN: origin });
    const res = await get(e);
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(lastLog()).toMatchObject({ event: "jobs_request", reason: "misconfigured", setting: "SITE_ORIGIN" });
    expect((await push(FEED_XML, e)).status).toBe(200);
  });

  it("does not need the feed's secrets to serve the list", async () => {
    await push(JOBS_XML, fallbackEnv());
    const res = await get(fallbackEnv({ FEED_BASIC_AUTH_PASS: undefined }));
    expect(res.status).toBe(200);
  });
});

describe("Framer components", () => {
  it("JobsFallback reads only fields the endpoint serves", () => {
    const used = new Set([...fallbackSource.matchAll(/\bjob\.([A-Za-z]+)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(0);
    for (const field of used) expect(FALLBACK_JOB_FIELDS).toContain(field);
  });

  it("JobsFallback never renders HTML; JobPosting escapes before writing the script element", () => {
    expect(fallbackSource).not.toContain("dangerouslySetInnerHTML");
    expect(fallbackSource).toContain('rel="noopener noreferrer"');
    expect(postingSource).toContain('.replace(/</g, "\\\\u003c")');
  });

  it("carry no em dashes and no raw JavaScript line terminators", () => {
    const banned = new RegExp(`[${[0x2014, 0x2028, 0x2029].map((c) => String.fromCharCode(c)).join("")}]`);
    expect(fallbackSource + postingSource).not.toMatch(banned);
  });
});
