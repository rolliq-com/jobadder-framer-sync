import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConfigError, loadConfig, type Config, type Env, type SyncConfig } from "../src/config";
import { JOB_FIELDS } from "../src/fields";
import { connectFramer } from "../src/framer";
import { LAST_PUSH_KEY, LAST_SYNC_KEY, readHealth } from "../src/health";
import { handleRequest, handleScheduled } from "../src/index";
import { CAPTURE_KEY, readStatus, STATUS_KEY, writeStatus } from "../src/store";
import { reconcile, runSync, sha256Hex } from "../src/sync";
import { version } from "../package.json";
import { FakeFramer, type FakeStep } from "./fake-framer";
import {
  ALL_JIDS,
  basicAuth,
  EMPTY_JOBS_XML,
  FEED_URL,
  jobsXmlWith,
  JOBS_XML,
  PASS,
  REJECTS_XML,
  USER,
} from "./fixtures";

const bindings = env as unknown as { FEED_CAPTURE: KVNamespace; FEED_CAPTURE_R2: R2Bucket };
const API_KEY = "fake-framer-key-0123456789";

function syncEnv(overrides: Partial<Env> = {}): Env {
  return {
    FEED_MODE: "sync",
    FEED_AUTH_MODE: "basic",
    FEED_BASIC_AUTH_USER: USER,
    FEED_BASIC_AUTH_PASS: PASS,
    CAPTURE_STORE: "kv",
    CAPTURE_BINDING: "FEED_CAPTURE",
    FEED_CAPTURE: bindings.FEED_CAPTURE,
    FEED_CAPTURE_R2: bindings.FEED_CAPTURE_R2,
    FRAMER_API_KEY: API_KEY,
    FRAMER_PROJECT_ID: "exampleProject12345a",
    HIRING_ORG_NAME: "Example Recruitment",
    HIRING_ORG_URL: "https://www.example.com/",
    JOB_COUNTRY: "NZ",
    ...overrides,
  };
}

function syncConfig(overrides: Partial<Env> = {}): Config & { sync: SyncConfig } {
  const config = loadConfig(syncEnv(overrides));
  return { ...config, sync: config.sync! };
}

async function run(framer: FakeFramer, xml: string, overrides: Partial<Env> = {}) {
  const payload = new TextEncoder().encode(xml);
  const sha256 = await sha256Hex(payload);
  return runSync({ config: syncConfig(overrides), payload, sha256, connect: framer.connect, trigger: "push" });
}

function post(xml: string) {
  const headers = { "Content-Type": "application/xml", Authorization: basicAuth(USER, PASS) };
  return new Request(FEED_URL, { method: "POST", headers, body: xml });
}

function context(): { ctx: ExecutionContext; settled: () => Promise<unknown[]> } {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} };
  return { ctx: ctx as unknown as ExecutionContext, settled: () => Promise.all(pending) };
}

let logSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of [CAPTURE_KEY, STATUS_KEY, LAST_PUSH_KEY, LAST_SYNC_KEY]) {
    await bindings.FEED_CAPTURE.delete(key);
    await bindings.FEED_CAPTURE_R2.delete(key);
  }
});

function logged(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(" ")).join("\n");
}
function syncLogs(): Record<string, unknown>[] {
  return [...logSpy.mock.calls, ...errSpy.mock.calls]
    .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((line) => line.event === "jobs_sync");
}

const status = () => readStatus({ kind: "kv", binding: bindings.FEED_CAPTURE });

describe("sync config", () => {
  it("is absent in capture mode", () => {
    expect(loadConfig(syncEnv({ FEED_MODE: "capture" })).sync).toBeUndefined();
  });

  it("reads the sync settings with their defaults", () => {
    const { sync } = syncConfig();
    expect(sync).toEqual({
      projectId: "exampleProject12345a",
      apiKey: API_KEY,
      collectionName: "Jobs",
      maxRemovalFraction: 0.5,
      massRemovalMinItems: 3,
      allowMassRemovalSha: undefined,
      jsonLd: { organisation: { name: "Example Recruitment", url: "https://www.example.com/" }, country: "NZ" },
    });
    expect(syncConfig({ SALARY_CURRENCY: "NZD", HIRING_ORG_URL: undefined }).sync.jsonLd).toEqual({
      organisation: { name: "Example Recruitment" },
      country: "NZ",
      salary: { currency: "NZD" },
    });
  });

  it.each([
    ["FRAMER_API_KEY", { FRAMER_API_KEY: undefined }],
    ["FRAMER_API_KEY", { FRAMER_API_KEY: "" }],
    ["FRAMER_PROJECT_ID", { FRAMER_PROJECT_ID: undefined }],
    ["FRAMER_PROJECT_ID", { FRAMER_PROJECT_ID: "has spaces" }],
    // The URL slug form: only the bare id after "--" is accepted.
    ["FRAMER_PROJECT_ID", { FRAMER_PROJECT_ID: "Site--exampleProject12345a" }],
    ["FRAMER_COLLECTION_NAME", { FRAMER_COLLECTION_NAME: "  " }],
    ["MAX_REMOVAL_FRACTION", { MAX_REMOVAL_FRACTION: "0" }],
    ["MAX_REMOVAL_FRACTION", { MAX_REMOVAL_FRACTION: "1.5" }],
    ["MAX_REMOVAL_FRACTION", { MAX_REMOVAL_FRACTION: "half" }],
    ["MASS_REMOVAL_MIN_ITEMS", { MASS_REMOVAL_MIN_ITEMS: "0" }],
    ["MASS_REMOVAL_MIN_ITEMS", { MASS_REMOVAL_MIN_ITEMS: "2.5" }],
    ["MASS_REMOVAL_MIN_ITEMS", { MASS_REMOVAL_MIN_ITEMS: "three" }],
    ["ALLOW_MASS_REMOVAL_SHA", { ALLOW_MASS_REMOVAL_SHA: "yes" }],
    ["HIRING_ORG_NAME", { HIRING_ORG_NAME: " " }],
    ["HIRING_ORG_URL", { HIRING_ORG_URL: "http://www.example.com/" }],
    ["JOB_COUNTRY", { JOB_COUNTRY: "nz" }],
    ["SALARY_CURRENCY", { SALARY_CURRENCY: "dollars" }],
  ] as [string, Partial<Env>][])("refuses a bad %s", (setting, overrides) => {
    expect(() => loadConfig(syncEnv(overrides))).toThrow(new ConfigError(setting));
  });
});

describe("runSync", () => {
  it("first sync sets the fields, writes every job, then publishes and deploys", async () => {
    const framer = new FakeFramer();
    const result = await run(framer, JOBS_XML);

    expect(result).toMatchObject({ outcome: "ok", jobs: 6, rejected: 0, upserted: 6, removed: 0, published: true });
    expect(framer.settings).toEqual([{ projectId: "exampleProject12345a", apiKey: API_KEY }]);
    expect(framer.collectionNames).toEqual(["Jobs"]);
    expect(framer.fields).toEqual(JOB_FIELDS);
    expect([...framer.live.keys()].sort()).toEqual(ALL_JIDS);
    expect(framer.calls).toEqual(["connect", "managedCollection", "setFields", "getItemIds", "addItems", "publish", "deploy"]);
    expect(framer.disconnects).toBe(1);

    const saved = await status();
    expect(saved).toMatchObject({ outcome: "ok", jobs: 6, unpublished: false });
    expect(Object.keys(saved!.items).sort()).toEqual(ALL_JIDS);
  });

  it("writes and publishes nothing when the same payload comes again", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);
    framer.calls = [];

    const result = await run(framer, JOBS_XML);
    expect(result).toMatchObject({ outcome: "ok", upserted: 0, removed: 0, published: false });
    expect(framer.calls).toEqual(["connect", "managedCollection", "setFields", "getItemIds"]);
    expect(framer.deployments).toBe(1);
  });

  it("writes only the job that changed", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);

    const edited = JOBS_XML.replace("Contract Analyst", "Senior Contract Analyst");
    const result = await run(framer, edited);
    expect(result).toMatchObject({ outcome: "ok", upserted: 1, published: true });
    expect(framer.live.get("2000003")!.fieldData.title.value).toBe("Senior Contract Analyst");
  });

  it("removes an ad that is no longer in the feed", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);

    const result = await run(framer, jobsXmlWith(ALL_JIDS.filter((id) => id !== "2000006")));
    expect(result).toMatchObject({ outcome: "ok", upserted: 0, removed: 1, published: true });
    expect(framer.live.has("2000006")).toBe(false);
    expect(framer.live.size).toBe(5);
  });

  it("re-writes an item that went missing from the site even if unchanged", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);
    framer.items.delete("2000002");

    const result = await run(framer, JOBS_XML);
    expect(result).toMatchObject({ upserted: 1, published: true });
    expect(framer.items.has("2000002")).toBe(true);
  });

  describe("mass removal guard", () => {
    const twoLeft = jobsXmlWith(["2000001", "2000002"]);

    it("holds removals above the threshold, applies the rest, and records the hold", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);

      const edited = twoLeft.replace("Senior Example Engineer", "Principal Example Engineer");
      const result = await run(framer, edited);
      expect(result).toMatchObject({ outcome: "held", reason: "mass_removal_held", upserted: 1, removed: 0, heldRemovals: 4 });
      expect(framer.live.size).toBe(6);
      expect(framer.live.get("2000001")!.fieldData.title.value).toBe("Principal Example Engineer");
      expect(await status()).toMatchObject({ outcome: "held", reason: "mass_removal_held" });
    });

    it("applies them for the one payload whose hash the override names", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);
      const sha = await sha256Hex(new TextEncoder().encode(twoLeft));

      const result = await run(framer, twoLeft, { ALLOW_MASS_REMOVAL_SHA: sha.slice(0, 12) });
      expect(result).toMatchObject({ outcome: "ok", removed: 4, published: true });
      expect([...framer.live.keys()].sort()).toEqual(["2000001", "2000002"]);
    });

    it("still holds them when the override names another payload", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);

      const result = await run(framer, twoLeft, { ALLOW_MASS_REMOVAL_SHA: "0123456789ab" });
      expect(result).toMatchObject({ outcome: "held", heldRemovals: 4 });
    });

    it("follows MAX_REMOVAL_FRACTION", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);

      const result = await run(framer, twoLeft, { MAX_REMOVAL_FRACTION: "0.7" });
      expect(result).toMatchObject({ outcome: "ok", removed: 4 });
    });

    it("holds an empty push over a board of six", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);

      const result = await run(framer, EMPTY_JOBS_XML);
      expect(result).toMatchObject({ outcome: "held", jobs: 0, heldRemovals: 6, published: false });
      expect(framer.live.size).toBe(6);
    });

    it("lets a small board's expiries through: 2 of 2 is under the minimum count", async () => {
      const framer = new FakeFramer();
      await run(framer, jobsXmlWith(["2000001", "2000002"]));

      const result = await run(framer, EMPTY_JOBS_XML);
      expect(result).toMatchObject({ outcome: "ok", jobs: 0, removed: 2, heldRemovals: 0, published: true });
      expect(framer.live.size).toBe(0);
    });

    it("lets 2 of 3 through but holds 3 of 4", async () => {
      const three = new FakeFramer();
      await run(three, jobsXmlWith(["2000001", "2000002", "2000003"]));
      expect(await run(three, jobsXmlWith(["2000001"]))).toMatchObject({ outcome: "ok", removed: 2 });

      const four = new FakeFramer();
      await run(four, jobsXmlWith(["2000001", "2000002", "2000003", "2000004"]));
      expect(await run(four, jobsXmlWith(["2000001"]))).toMatchObject({ outcome: "held", removed: 0, heldRemovals: 3 });
      expect(four.live.size).toBe(4);
    });

    it("follows MASS_REMOVAL_MIN_ITEMS: 1 holds on the share alone", async () => {
      const framer = new FakeFramer();
      await run(framer, jobsXmlWith(["2000001", "2000002"]));

      const result = await run(framer, EMPTY_JOBS_XML, { MASS_REMOVAL_MIN_ITEMS: "1" });
      expect(result).toMatchObject({ outcome: "held", heldRemovals: 2 });
      expect(framer.live.size).toBe(2);
    });

    it("accepts an empty board over an empty collection, with nothing to publish", async () => {
      const framer = new FakeFramer();
      const result = await run(framer, EMPTY_JOBS_XML);
      expect(result).toMatchObject({ outcome: "ok", jobs: 0, published: false });
    });
  });

  describe("refused payloads never reach the site", () => {
    it("refuses a feed where every ad was rejected", async () => {
      const framer = new FakeFramer();
      const allRejected = REJECTS_XML.replace("<Title>Kept</Title>", "<Title> </Title>").replace(
        "<Title>Duplicate id</Title>",
        "<Title> </Title>",
      );
      const result = await run(framer, allRejected);
      expect(result).toMatchObject({ outcome: "refused", reason: "no_usable_jobs", jobs: 0 });
      expect(result.rejected).toBeGreaterThan(0);
      expect(framer.calls).toEqual([]);
      expect(await status()).toMatchObject({ outcome: "refused", reason: "no_usable_jobs" });
    });

    it("refuses a payload that is not a jobs feed, keeping the item hashes", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);
      framer.calls = [];

      const result = await run(framer, `<?xml version="1.0"?><Other/>`);
      expect(result).toMatchObject({ outcome: "refused", reason: "not_jobs_root" });
      expect(framer.calls).toEqual([]);
      expect(Object.keys((await status())!.items)).toHaveLength(6);
    });
  });

  describe("Framer failures", () => {
    const cases: [FakeStep, string][] = [
      ["connect", "framer_connect"],
      ["managedCollection", "framer_connect"],
      ["setFields", "framer_write"],
      ["getItemIds", "framer_write"],
      ["addItems", "framer_write"],
      ["removeItems", "framer_write"],
      ["publish", "framer_publish"],
      ["deploy", "framer_deploy"],
    ];

    it.each(cases)("a failure at %s is recorded as %s and logged without its message", async (step, reason) => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);
      const before = (await status())!.items;
      const disconnects = framer.disconnects;

      // An edit and a removal, so every step runs.
      framer.failAt = step;
      const next = jobsXmlWith(ALL_JIDS.filter((id) => id !== "2000006")).replace("Contract Analyst", "Analyst");
      const result = await run(framer, next);

      expect(result).toMatchObject({ outcome: "error", reason });
      expect(framer.disconnects).toBe(step === "connect" ? disconnects : disconnects + 1);
      const saved = await status();
      expect(saved).toMatchObject({ outcome: "error", reason });
      expect(saved!.items).toEqual(before);
      expect(logged()).not.toContain(API_KEY);
      expect(logged()).not.toContain("api.example.test");
    });

    it("publishes on the retry when an earlier run wrote but did not deploy", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);
      const shrunk = jobsXmlWith(ALL_JIDS.filter((id) => id !== "2000006"));

      framer.failAt = "publish";
      expect(await run(framer, shrunk)).toMatchObject({ outcome: "error", removed: 1 });
      expect(await status()).toMatchObject({ unpublished: true });
      expect(framer.live.size).toBe(6);

      // Nothing is left to write, but the removal is still not live.
      framer.failAt = undefined;
      expect(await run(framer, shrunk)).toMatchObject({ outcome: "ok", upserted: 0, removed: 0, published: true });
      expect(framer.live.size).toBe(5);
      expect(await status()).toMatchObject({ unpublished: false });
    });

    it("never throws: a throw outside the Framer steps is one logged error with a fixed code", async () => {
      const framer = new FakeFramer();
      const connect: typeof framer.connect = async (settings) => {
        const session = await framer.connect(settings);
        return {
          ...session,
          disconnect: () => {
            throw new Error(`disconnect failed: ${settings.apiKey}`);
          },
        };
      };
      const payload = new TextEncoder().encode(JOBS_XML);
      const result = runSync({ config: syncConfig(), payload, sha256: await sha256Hex(payload), connect, trigger: "push" });
      await expect(result).resolves.toMatchObject({ outcome: "error", reason: "internal" });
      expect(syncLogs()).toEqual([expect.objectContaining({ outcome: "error", reason: "internal", trigger: "push" })]);
      expect(logged()).not.toContain(API_KEY);
    });

    it("the shipped connector sends the key in a header, never the URL, and a refused connection is framer_connect", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
      const payload = new TextEncoder().encode(JOBS_XML);
      const result = await runSync({
        config: syncConfig(),
        payload,
        sha256: await sha256Hex(payload),
        connect: connectFramer,
        trigger: "push",
      });
      expect(result).toMatchObject({ outcome: "error", reason: "framer_connect" });
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).not.toContain(API_KEY);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Token ${API_KEY}`);
      expect(logged()).not.toContain(API_KEY);
      fetchSpy.mockRestore();
    });
  });

  it("logs counts and codes only: no job text, key or project id", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);
    const text = logged();
    expect(text).not.toContain("Senior Example Engineer");
    expect(text).not.toContain("apply.example.com");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("exampleProject12345a");
    expect(Object.keys(syncLogs()[0]!).sort()).toEqual(
      ["event", "outcome", "trigger", "jobs", "rejected", "upserted", "removed", "heldRemovals", "published", "sha256", "ms"].sort(),
    );
  });

  it("keeps its status in R2 when the store is R2", async () => {
    const framer = new FakeFramer();
    const result = await run(framer, JOBS_XML, { CAPTURE_STORE: "r2", CAPTURE_BINDING: "FEED_CAPTURE_R2" });
    expect(result.outcome).toBe("ok");
    expect(await readStatus({ kind: "r2", binding: bindings.FEED_CAPTURE_R2 })).toMatchObject({ outcome: "ok", jobs: 6 });
    expect(await status()).toBeNull();
  });
});

describe("sync mode on the Worker", () => {
  it("stores the push, answers 200, then syncs it in the background", async () => {
    const framer = new FakeFramer();
    const { ctx, settled } = context();
    const res = await handleRequest(post(JOBS_XML), syncEnv(), ctx, { connect: framer.connect });
    expect(res.status).toBe(200);
    expect(await bindings.FEED_CAPTURE.get(CAPTURE_KEY, "text")).toBe(JOBS_XML);

    const results = await settled();
    expect(results).toHaveLength(1);
    expect(framer.live.size).toBe(6);
    expect(syncLogs()).toMatchObject([{ outcome: "ok", trigger: "push" }]);
  });

  it("still captures and answers 200 when the sync fails", async () => {
    const framer = new FakeFramer();
    framer.failAt = "connect";
    const { ctx, settled } = context();
    const res = await handleRequest(post(JOBS_XML), syncEnv(), ctx, { connect: framer.connect });
    expect(res.status).toBe(200);
    await settled();
    expect(await bindings.FEED_CAPTURE.get(CAPTURE_KEY, "text")).toBe(JOBS_XML);
    expect(await status()).toMatchObject({ outcome: "error", reason: "framer_connect" });
  });

  it("answers 503 and stores nothing when a sync setting is missing", async () => {
    const framer = new FakeFramer();
    const res = await handleRequest(post(JOBS_XML), syncEnv({ FRAMER_API_KEY: undefined }), undefined, {
      connect: framer.connect,
    });
    expect(res.status).toBe(503);
    expect(logged()).toContain('"setting":"FRAMER_API_KEY"');
    expect(await bindings.FEED_CAPTURE.get(CAPTURE_KEY)).toBeNull();
    expect(framer.settings).toEqual([]);
  });

  it("never syncs in capture mode", async () => {
    const framer = new FakeFramer();
    const { ctx, settled } = context();
    const res = await handleRequest(post(JOBS_XML), syncEnv({ FEED_MODE: "capture" }), ctx, { connect: framer.connect });
    expect(res.status).toBe(200);
    await settled();
    expect(framer.calls).toEqual([]);
    await handleScheduled(syncEnv({ FEED_MODE: "capture" }), { connect: framer.connect });
    expect(framer.calls).toEqual([]);
  });
});

describe("cron reconcile", () => {
  const kv = { kind: "kv" as const, binding: bindings.FEED_CAPTURE };

  async function capture(xml: string) {
    const res = await handleRequest(post(xml), syncEnv({ FEED_MODE: "capture" }));
    expect(res.status).toBe(200);
    return sha256Hex(new TextEncoder().encode(xml));
  }

  it("does nothing before the first push", async () => {
    const framer = new FakeFramer();
    expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "skipped", reason: "no_capture" });
    expect(framer.calls).toEqual([]);
  });

  it("syncs a payload that was never synced", async () => {
    const framer = new FakeFramer();
    await capture(JOBS_XML);
    await handleScheduled(syncEnv(), { connect: framer.connect });
    expect(framer.live.size).toBe(6);
    expect(syncLogs()).toMatchObject([{ outcome: "ok", trigger: "cron" }]);
  });

  it.each(["ok", "refused"] as const)("skips a payload whose last run on this release ended %s", async (outcome) => {
    const framer = new FakeFramer();
    const sha256 = await capture(JOBS_XML);
    await writeStatus(kv, { sha256, outcome, at: "2026-10-27T00:00:00Z", jobs: 6, items: {}, version });
    expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "skipped", reason: "up_to_date" });
    expect(framer.calls).toEqual([]);
  });

  it.each(["error", "held"] as const)("re-runs a payload whose last run ended %s", async (outcome) => {
    const framer = new FakeFramer();
    const sha256 = await capture(JOBS_XML);
    await writeStatus(kv, { sha256, outcome, at: "2026-10-27T00:00:00Z", jobs: 6, items: {} });
    expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "ok", trigger: "cron" });
  });

  describe("after a new release", () => {
    // As if an earlier release had synced this payload: same feed, older (or no) version.
    async function syncedByEarlierRelease(framer: FakeFramer, earlier: string | undefined) {
      const sha256 = await capture(JOBS_XML);
      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "ok", upserted: 6 });
      const status = (await readStatus(kv))!;
      expect(status.version).toBe(version);
      await writeStatus(kv, { ...status, version: earlier });
      framer.calls = [];
      return { sha256, status };
    }

    it.each(["0.0.0", undefined])("re-syncs the same feed once when release %s did the last sync, then skips", async (earlier) => {
      const framer = new FakeFramer();
      await syncedByEarlierRelease(framer, earlier);

      // Nothing an ad shows changed here, so nothing is written or published.
      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "ok", trigger: "cron", upserted: 0, published: false });
      expect((await readStatus(kv))?.version).toBe(version);

      framer.calls = [];
      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "skipped", reason: "up_to_date" });
      expect(framer.calls).toEqual([]);
    });

    it("writes and publishes only the ads whose written form changed", async () => {
      const framer = new FakeFramer();
      const { status } = await syncedByEarlierRelease(framer, "0.0.0");
      // The earlier release wrote 2000003 differently: its stored hash no longer matches.
      await writeStatus(kv, { ...status, version: "0.0.0", items: { ...status.items, "2000003": "0".repeat(32) } });

      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "ok", upserted: 1, removed: 0, published: true });
      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "skipped", reason: "up_to_date" });
    });

    it("still holds mass removals", async () => {
      const framer = new FakeFramer();
      await run(framer, JOBS_XML);
      const sha256 = await capture(jobsXmlWith(["2000001"]));
      await writeStatus(kv, { ...(await readStatus(kv))!, sha256, outcome: "ok", version: "0.0.0" });

      expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "held", reason: "mass_removal_held", heldRemovals: 5 });
      expect(framer.live.size).toBe(6);
    });
  });

  it("re-runs when a newer payload arrived than the last synced one", async () => {
    const framer = new FakeFramer();
    await capture(JOBS_XML);
    await reconcile(syncConfig(), framer.connect);
    await capture(jobsXmlWith(ALL_JIDS.filter((id) => id !== "2000006")));
    expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "ok", removed: 1 });
  });

  it("clears a held launch push on the next run once the override names its logged hash", async () => {
    // docs/DEPLOY.md "The launch push": sample jobs first, then a real push that replaces them.
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);
    const sha256 = await capture(jobsXmlWith(["2000001"]));

    const held = await reconcile(syncConfig(), framer.connect);
    expect(held).toMatchObject({ outcome: "held", reason: "mass_removal_held", heldRemovals: 5, sha256: sha256.slice(0, 12) });
    expect(framer.live.size).toBe(6);

    const cleared = await reconcile(syncConfig({ ALLOW_MASS_REMOVAL_SHA: held.sha256 }), framer.connect);
    expect(cleared).toMatchObject({ outcome: "ok", removed: 5, published: true });
    expect([...framer.live.keys()]).toEqual(["2000001"]);
  });

  it("logs a misconfiguration by setting name and does nothing", async () => {
    const framer = new FakeFramer();
    await handleScheduled(syncEnv({ JOB_COUNTRY: undefined }), { connect: framer.connect });
    expect(syncLogs()).toMatchObject([{ outcome: "error", trigger: "cron", reason: "misconfigured", setting: "JOB_COUNTRY" }]);
    expect(framer.calls).toEqual([]);
  });
});

describe("the record GET /status reads", () => {
  const kv = { kind: "kv" as const, binding: bindings.FEED_CAPTURE };
  const health = () => readHealth(kv);
  const sha12 = async (xml: string) => (await sha256Hex(new TextEncoder().encode(xml))).slice(0, 12);

  it("records a capture-mode push, with no sync", async () => {
    const { ctx, settled } = context();
    await handleRequest(post(JOBS_XML), syncEnv({ FEED_MODE: "capture" }), ctx);
    await settled();
    expect(await health()).toEqual({ last_push: { at: expect.any(String), sha256: await sha12(JOBS_XML) }, last_sync: null });
  });

  it("records a sync-mode push and the sync it ran", async () => {
    const framer = new FakeFramer();
    const { ctx, settled } = context();
    await handleRequest(post(JOBS_XML), syncEnv(), ctx, { connect: framer.connect });
    await settled();
    const sha = await sha12(JOBS_XML);
    expect(await health()).toMatchObject({
      last_push: { sha256: sha },
      last_sync: { outcome: "ok", trigger: "push", jobs: 6, upserted: 6, removed: 0, held_removals: 0, published: true, sha256: sha },
    });
  });

  it("records a failed sync by its reason code only", async () => {
    const framer = new FakeFramer();
    framer.failAt = "connect";
    const { ctx, settled } = context();
    await handleRequest(post(JOBS_XML), syncEnv(), ctx, { connect: framer.connect });
    await settled();
    expect((await health()).last_sync).toMatchObject({ outcome: "error", reason: "framer_connect", published: false });
    expect(await bindings.FEED_CAPTURE.get(LAST_SYNC_KEY, "text")).not.toContain(API_KEY);
  });

  it("records a cron sync, keeps the push's record, and writes nothing on a skip", async () => {
    const framer = new FakeFramer();
    await handleRequest(post(JOBS_XML), syncEnv({ FEED_MODE: "capture" }));
    const pushed = (await health()).last_push;
    expect(pushed).not.toBeNull();
    await reconcile(syncConfig(), framer.connect);
    expect(await health()).toMatchObject({ last_push: pushed!, last_sync: { outcome: "ok", trigger: "cron", version } });

    await bindings.FEED_CAPTURE.delete(LAST_SYNC_KEY);
    expect(await reconcile(syncConfig(), framer.connect)).toMatchObject({ outcome: "skipped", reason: "up_to_date" });
    expect(await bindings.FEED_CAPTURE.get(LAST_SYNC_KEY)).toBeNull();
  });

  it("records a held sync, with the hash the override needs", async () => {
    const framer = new FakeFramer();
    await run(framer, JOBS_XML);
    const xml = jobsXmlWith(["2000001"]);
    await handleRequest(post(xml), syncEnv(), undefined, { connect: framer.connect });
    expect((await health()).last_sync).toMatchObject({
      outcome: "held",
      reason: "mass_removal_held",
      held_removals: 5,
      sha256: await sha12(xml),
    });
  });

  it("records the push before its sync, so a sync that never finishes still shows the push", async () => {
    const framer = new FakeFramer();
    let release!: () => void;
    const hang = new Promise<never>((_, reject) => (release = () => reject(new Error("cut off"))));
    const connect = (() => hang) as unknown as typeof framer.connect;
    const { ctx } = context();
    expect((await handleRequest(post(JOBS_XML), syncEnv(), ctx, { connect })).status).toBe(200);
    // The sync is still connecting: the push is already recorded, the sync is not.
    await vi.waitFor(async () => expect((await health()).last_push).toMatchObject({ sha256: await sha12(JOBS_XML) }));
    expect((await health()).last_sync).toBeNull();
    release();
  });

  it("keeps the last sync on a later capture-mode push", async () => {
    const framer = new FakeFramer();
    await handleRequest(post(JOBS_XML), syncEnv(), undefined, { connect: framer.connect });
    await handleRequest(post(EMPTY_JOBS_XML), syncEnv({ FEED_MODE: "capture" }));
    expect(await health()).toMatchObject({ last_push: { sha256: await sha12(EMPTY_JOBS_XML) }, last_sync: { outcome: "ok", trigger: "push" } });
  });

  it("still answers a push 200 when the record cannot be written", async () => {
    const real = bindings.FEED_CAPTURE;
    const failing = {
      get: real.get.bind(real),
      put: (key: string, value: Uint8Array, options?: KVNamespacePutOptions) =>
        key === LAST_PUSH_KEY ? Promise.reject(new Error("kv down")) : real.put(key, value, options),
    };
    const res = await handleRequest(post(JOBS_XML), syncEnv({ FEED_MODE: "capture", FEED_CAPTURE: failing }));
    expect(res.status).toBe(200);
    expect(await real.get(CAPTURE_KEY, "text")).toBe(JOBS_XML);
    expect(await real.get(LAST_PUSH_KEY)).toBeNull();
  });
});
