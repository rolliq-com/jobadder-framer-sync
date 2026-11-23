import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { version } from "../package.json";
import type { Env } from "../src/config";
import { LAST_PUSH_KEY, LAST_SYNC_KEY } from "../src/health";
import { handleRequest } from "../src/index";
import { CAPTURE_KEY } from "../src/store";
import type { StatusBody } from "../src/status";
import { basicAuth, FEED_XML, PASS, PATH_SECRET, USER } from "./fixtures";

const bindings = env as unknown as { FEED_CAPTURE: KVNamespace; FEED_CAPTURE_R2: R2Bucket };
const HOST = "feed.example.test";
const STATUS_URL = `https://${HOST}/status`;
const API_KEY = "fake-framer-key-0123456789";
const PROJECT_ID = "exampleProject12345a";

// Every test runs on its own deployment id, so the 30-second cache never
// carries an answer from one test into the next.
let deploymentId: string;

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    FEED_MODE: "capture",
    FEED_AUTH_MODE: "basic",
    FEED_BASIC_AUTH_USER: USER,
    FEED_BASIC_AUTH_PASS: PASS,
    CAPTURE_STORE: "kv",
    CAPTURE_BINDING: "FEED_CAPTURE",
    FEED_CAPTURE: bindings.FEED_CAPTURE,
    FEED_CAPTURE_R2: bindings.FEED_CAPTURE_R2,
    CF_VERSION_METADATA: { id: deploymentId, tag: "release-tag", timestamp: "2026-11-06T01:02:03.000Z" },
    ...overrides,
  };
}

function syncEnv(overrides: Partial<Env> = {}): Env {
  return testEnv({
    FEED_MODE: "sync",
    FRAMER_API_KEY: API_KEY,
    FRAMER_PROJECT_ID: PROJECT_ID,
    HIRING_ORG_NAME: "Example Recruitment",
    HIRING_ORG_URL: "https://www.example.com/",
    JOB_COUNTRY: "NZ",
    ...overrides,
  });
}

function get(url = STATUS_URL, method = "GET") {
  return new Request(url, { method });
}

async function status(e: Env, url?: string): Promise<{ res: Response; body: StatusBody; text: string }> {
  const res = await handleRequest(get(url), e);
  const text = await res.text();
  return { res, body: JSON.parse(text) as StatusBody, text };
}

let logSpy: MockInstance;
beforeEach(() => {
  deploymentId = crypto.randomUUID();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of [CAPTURE_KEY, LAST_PUSH_KEY, LAST_SYNC_KEY]) {
    await bindings.FEED_CAPTURE.delete(key);
    await bindings.FEED_CAPTURE_R2.delete(key);
  }
  await caches.default.delete(new Request(`${STATUS_URL}?v=none`));
});

describe("GET /status", () => {
  it("reports the release, deployment, mode and settings before the first push", async () => {
    const { res, body } = await status(testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(body).toEqual({
      service: "jobadder-feed-worker",
      version,
      deployment: { id: deploymentId, at: "2026-11-06T01:02:03.000Z" },
      feed_mode: "capture",
      config: "ok",
      jobs_fallback: "off",
      mass_removal_override: false,
      records: "ok",
      last_push: null,
      last_sync: null,
    });
  });

  it("carries the release version from package.json", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shows the last push once one is stored", async () => {
    const push = new Request(`https://${HOST}/`, {
      method: "POST",
      headers: { "Content-Type": "application/xml", Authorization: basicAuth(USER, PASS) },
      body: FEED_XML,
    });
    expect((await handleRequest(push, testEnv())).status).toBe(200);
    const { body } = await status(testEnv());
    expect(body.last_push).toEqual({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), sha256: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(body.last_sync).toBeNull();
  });

  it("answers in sync mode with a valid configuration", async () => {
    const { body } = await status(syncEnv());
    expect(body).toMatchObject({ feed_mode: "sync", config: "ok" });
  });

  it("names an invalid setting, never its value", async () => {
    const { body, text } = await status(syncEnv({ FRAMER_PROJECT_ID: "not-a-valid-project-id-xyz" }));
    expect(body.config).toEqual({ invalid: "FRAMER_PROJECT_ID" });
    expect(text).not.toContain("not-a-valid-project-id-xyz");
  });

  it("names a missing secret", async () => {
    const { body } = await status(syncEnv({ FRAMER_API_KEY: undefined }));
    expect(body.config).toEqual({ invalid: "FRAMER_API_KEY" });
  });

  it("never echoes an unknown mode", async () => {
    const { body, text } = await status(testEnv({ FEED_MODE: "weird-mode-value" }));
    expect(body).toMatchObject({ feed_mode: "invalid", config: { invalid: "FEED_MODE" } });
    expect(text).not.toContain("weird-mode-value");
  });

  it("contains no secret or setting value in any mode", async () => {
    const override = "0123456789ab";
    const envs = [
      syncEnv({ ALLOW_MASS_REMOVAL_SHA: override, SALARY_CURRENCY: "NZD" }),
      testEnv({ FEED_AUTH_MODE: "path", FEED_PATH_SECRET: PATH_SECRET, FEED_BASIC_AUTH_USER: undefined, FEED_BASIC_AUTH_PASS: undefined }),
    ];
    for (const e of envs) {
      deploymentId = crypto.randomUUID();
      const { text, body } = await status({ ...e, CF_VERSION_METADATA: { id: deploymentId, tag: "t", timestamp: "" } });
      expect(body.config).toBe("ok");
      for (const secret of [PASS, USER, PATH_SECRET, API_KEY, PROJECT_ID, override, "Example Recruitment", "www.example.com", "basic", "path"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("says a mass-removal override is armed without showing it", async () => {
    const { body, text } = await status(syncEnv({ ALLOW_MASS_REMOVAL_SHA: "0123456789ab" }));
    expect(body.mass_removal_override).toBe(true);
    expect(text).not.toContain("0123456789ab");
  });

  it("checks the jobs fallback's settings only when it is on", async () => {
    expect((await status(testEnv({ JOBS_FALLBACK: "on" }))).body.jobs_fallback).toEqual({ invalid: "SITE_ORIGIN" });
    deploymentId = crypto.randomUUID();
    const on = testEnv({ JOBS_FALLBACK: "on", SITE_ORIGIN: "https://www.example.com" });
    expect((await status(on)).body.jobs_fallback).toBe("ok");
  });

  it("works in path mode, and its path is not the secret path", async () => {
    const e = testEnv({ FEED_AUTH_MODE: "path", FEED_PATH_SECRET: PATH_SECRET, FEED_BASIC_AUTH_USER: undefined, FEED_BASIC_AUTH_PASS: undefined });
    const { res, body } = await status(e);
    expect(res.status).toBe(200);
    expect(body.config).toBe("ok");
    // The secret path still takes the feed path.
    const res2 = await handleRequest(new Request(`https://${HOST}/${PATH_SECRET}`, { method: "GET" }), e);
    expect(res2.status).toBe(405);
  });

  it("still answers when the store binding is broken, and says the records are unset", async () => {
    const { res, body } = await status(testEnv({ CAPTURE_BINDING: "MISSING" }));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ config: { invalid: "CAPTURE_BINDING" }, records: "unset", last_push: null });
  });

  it("says the records are unreadable when the store fails, and does not cache that", async () => {
    const failing = { put: () => Promise.resolve(), get: () => Promise.reject(new Error("kv down")) };
    const e = testEnv({ FEED_CAPTURE: failing });
    expect((await status(e)).body.records).toBe("unreadable");
    expect(await caches.default.match(new Request(`${STATUS_URL}?v=${deploymentId}`))).toBeUndefined();
  });

  it("reads from R2 when the capture is in R2", async () => {
    await bindings.FEED_CAPTURE_R2.put(LAST_PUSH_KEY, JSON.stringify({ at: "2026-11-06T00:00:00.000Z", sha256: "abcdef012345" }));
    const { body } = await status(testEnv({ CAPTURE_STORE: "r2", CAPTURE_BINDING: "FEED_CAPTURE_R2" }));
    expect(body.last_push).toEqual({ at: "2026-11-06T00:00:00.000Z", sha256: "abcdef012345" });
  });

  it("passes on only known fields of the expected types from the stored record", async () => {
    await bindings.FEED_CAPTURE.put(
      LAST_PUSH_KEY,
      JSON.stringify({ at: "2026-11-06T00:00:00.000Z", sha256: "abcdef012345", extra: "leak" }),
    );
    await bindings.FEED_CAPTURE.put(
      LAST_SYNC_KEY,
      JSON.stringify({ outcome: "ok", trigger: "cron", at: "2026-11-06T00:00:00.000Z", ms: 5, reason: "<script>", jobs: "6", title: "leak" }),
    );
    const { body, text } = await status(testEnv());
    expect(text).not.toContain("leak");
    expect(text).not.toContain("<script>");
    expect(body.last_sync).toMatchObject({ outcome: "ok", trigger: "cron", ms: 5 });
    expect(body.last_sync?.jobs).toBeUndefined();
  });

  it("treats a corrupt record as no record", async () => {
    await bindings.FEED_CAPTURE.put(LAST_PUSH_KEY, "not json");
    await bindings.FEED_CAPTURE.put(LAST_SYNC_KEY, JSON.stringify({ outcome: "ok" }));
    expect((await status(testEnv())).body).toMatchObject({ records: "ok", last_push: null, last_sync: null });
  });

  it("reports no deployment when the version binding is absent", async () => {
    const { body } = await status(testEnv({ CF_VERSION_METADATA: undefined }));
    expect(body.deployment).toBeNull();
  });
});

describe("GET /status caching", () => {
  it("serves one cached answer per deployment, whatever the query string", async () => {
    const e = testEnv();
    expect((await status(e)).body.last_push).toBeNull();
    await bindings.FEED_CAPTURE.put(LAST_PUSH_KEY, JSON.stringify({ at: "2026-11-06T00:00:00.000Z", sha256: "abcdef012345" }));
    expect((await status(e, `${STATUS_URL}?bust=${Date.now()}`)).body.last_push).toBeNull();
    const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.filter((l) => l.event === "status_request").map((l) => l.cache)).toEqual(["miss", "hit"]);

    // A new deployment (a code deploy or a dashboard settings edit) is shown at once.
    deploymentId = crypto.randomUUID();
    expect((await status(testEnv())).body.last_push).not.toBeNull();
  });
});

describe("other requests to /status", () => {
  it("answers HEAD without a body", async () => {
    const res = await handleRequest(get(STATUS_URL, "HEAD"), testEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("refuses plain HTTP", async () => {
    const res = await handleRequest(get(`http://${HOST}/status`), testEnv());
    expect(res.status).toBe(403);
  });

  it("sends a POST to the feed path unchanged", async () => {
    const res = await handleRequest(new Request(STATUS_URL, { method: "POST", body: "x" }), testEnv());
    expect(res.status).toBe(404);
    // With the feed itself on /status (basic mode), a POST is still the feed.
    const push = new Request(STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/xml", Authorization: basicAuth(USER, PASS) },
      body: FEED_XML,
    });
    expect((await handleRequest(push, testEnv({ FEED_PATH: "/status" }))).status).toBe(200);
  });

  it("logs one allow-listed line", async () => {
    await status(testEnv());
    const line = JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as Record<string, unknown>;
    expect(line).toEqual({ event: "status_request", outcome: "served", status: 200, cache: "miss", ms: expect.any(Number) });
  });
});
