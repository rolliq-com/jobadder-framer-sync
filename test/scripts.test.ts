import { describe, expect, it } from "vitest";
import { applySettings, normalizeHostname, readSettings } from "../scripts/lib/config-edit.mjs";
import { countEmails, formatStatus, generatePassword, generateUsername, interpretSmoke, isSmokePayload, smokeFeed, stripEmailTo } from "../scripts/lib/feed.mjs";
import { jobadderEmail } from "../scripts/lib/email.mjs";
import { activeVersionId, fileVars, isNothingLive, liveVars, MASS_REMOVAL_SHA, planVars, varArgs } from "../scripts/lib/live-vars.mjs";
import trackedConfig from "../wrangler.jsonc?raw";
import { MIN_PASSWORD_LENGTH } from "../src/config";
import { checkXml } from "../src/xml";
import { FEED_XML } from "./fixtures";

// The shape of the tracked wrangler.jsonc, comments included.
const CONFIG = `// Deploy-time configuration.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "jobadder-feed-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",

  // One entry point only.
  "workers_dev": false,
  "routes": [{ "pattern": "<FEED_HOSTNAME>", "custom_domain": true }],
  "vars": {
    "FEED_AUTH_MODE": "basic",
    "FEED_PATH": "/",
    "CAPTURE_STORE": "kv",
    "CAPTURE_BINDING": "FEED_CAPTURE"
  },
  "kv_namespaces": [{ "binding": "FEED_CAPTURE", "id": "<KV_NAMESPACE_ID>" }],
  // "r2_buckets": [{ "binding": "FEED_CAPTURE", "bucket_name": "<R2_BUCKET_NAME>" }],
}
`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KV = "fedcba9876543210fedcba9876543210";

describe("wrangler.jsonc settings", () => {
  it("reads placeholders as unset", () => {
    expect(readSettings(CONFIG)).toMatchObject({ accountId: "", hostname: "", kvId: "", store: "kv", binding: "FEED_CAPTURE", r2Bucket: "" });
  });

  it("fills placeholders, adds account_id once, and keeps every comment", () => {
    const out = applySettings(CONFIG, { accountId: ACCOUNT, hostname: "Jobs-Feed.Example.com", kvId: KV });
    expect(readSettings(out)).toMatchObject({ accountId: ACCOUNT, hostname: "jobs-feed.example.com", kvId: KV });
    expect(out.match(/"account_id"/g)).toHaveLength(1);
    for (const comment of CONFIG.match(/\/\/.*$/gm)!) expect(out).toContain(comment);
  });

  it("is idempotent and updates existing values on a rerun", () => {
    const once = applySettings(CONFIG, { accountId: ACCOUNT, hostname: "a.example.com", kvId: KV });
    expect(applySettings(once, { accountId: ACCOUNT, hostname: "a.example.com", kvId: KV })).toBe(once);
    const moved = applySettings(once, { accountId: KV, hostname: "b.example.com" });
    expect(readSettings(moved)).toMatchObject({ accountId: KV, hostname: "b.example.com", kvId: KV });
    expect(moved.match(/"account_id"/g)).toHaveLength(1);
  });

  it("refuses a file it does not recognise rather than guessing", () => {
    expect(() => applySettings("{}", { kvId: KV })).toThrow(/git checkout wrangler.jsonc/);
  });

  it("rejects malformed ids", () => {
    expect(() => applySettings(CONFIG, { accountId: "my-account" })).toThrow(/account ID/);
    expect(() => applySettings(CONFIG, { kvId: '"; evil' })).toThrow(/KV namespace ID/);
  });

  it.each([
    ["https://jobs-feed.example.com/", "jobs-feed.example.com"],
    ["  JOBS.example.co.nz ", "jobs.example.co.nz"],
  ])("normalises %j", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each(["example", "jobs feed.example.com", "jobs.example.com/path", "-bad.example.com", "10.0.0.1", ""])("rejects %j", (input) => {
    expect(() => normalizeHostname(input)).toThrow(/not a hostname/);
  });
});

describe("removing EmailTo", () => {
  it("removes the fixture's Apply/EmailTo and keeps everything else byte for byte", () => {
    const result = stripEmailTo(FEED_XML);
    expect(result).toMatchObject({ removed: 1, jobs: 1, otherEmails: 0 });
    expect(result.xml).not.toContain("EmailTo");
    expect(result.xml).not.toContain("applications@example.com");
    expect(result.xml).toBe(FEED_XML.replace(/\n\s*<EmailTo>[^<]*<\/EmailTo>/, ""));
  });

  it("removes self-closing, attributed, prefixed and out-of-Apply EmailTo elements in every job", () => {
    const xml = `<Jobs>
  <Job jid="1"><Apply><Url>u</Url><EmailTo type="a>b">a@example.com</EmailTo></Apply></Job>
  <Job jid="2"><Apply><EmailTo/></Apply></Job>
  <Job jid="3"><Apply><x:EmailTo xmlns:x="urn:x">c@example.com</x:EmailTo></Apply><EmailTo>d@example.com</EmailTo></Job>
</Jobs>`;
    const result = stripEmailTo(xml);
    expect(result).toMatchObject({ removed: 4, jobs: 3, otherEmails: 0 });
    expect(result.xml).toBe(`<Jobs>
  <Job jid="1"><Apply><Url>u</Url></Apply></Job>
  <Job jid="2"><Apply></Apply></Job>
  <Job jid="3"><Apply></Apply></Job>
</Jobs>`);
    expect(checkXml(new TextEncoder().encode(result.xml)).ok).toBe(true);
  });

  it("leaves EmailTo text inside CDATA and comments alone, and counts addresses left in text", () => {
    const xml = `<Jobs><Job jid="1"><Description><![CDATA[Write to <EmailTo>x@example.com</EmailTo>]]></Description><!-- <EmailTo/> --></Job></Jobs>`;
    const result = stripEmailTo(xml);
    expect(result.removed).toBe(0);
    expect(result.xml).toBe(xml);
    expect(result.otherEmails).toBe(1);
  });

  it("fails closed on malformed input", () => {
    expect(() => stripEmailTo("<Jobs><Job><EmailTo>a@b.com</Job></Jobs>")).toThrow();
    expect(() => stripEmailTo("<Jobs><EmailTo>unterminated")).toThrow();
  });

  it("counts plausible addresses only", () => {
    expect(countEmails("mail a.b+c@example.co.nz or not@this")).toBe(1);
  });
});

describe("setup smoke test", () => {
  it("posts a well-formed, real-sized synthetic feed that capture recognises as a test", () => {
    const feed = smokeFeed();
    const check = checkXml(new TextEncoder().encode(feed));
    expect(check).toEqual({ ok: true, root: "Jobs" });
    expect(stripEmailTo(feed).jobs).toBe(40);
    expect(isSmokePayload(feed)).toBe(true);
    expect(isSmokePayload(" <Jobs/>\n")).toBe(true);
    expect(isSmokePayload(FEED_XML)).toBe(false);
  });

  it("generates credentials the Worker accepts", () => {
    const pass = generatePassword();
    expect(pass).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(pass.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(generatePassword()).not.toBe(pass);
    expect(generateUsername()).toMatch(/^jobadder-[a-z2-9]{8}$/);
  });

  it.each([
    ["login", 200, "ok", true, false],
    ["probe", 400, "bad request", true, false],
    ["wrong-login", 401, "unauthorized", true, false],
    ["wrong-login", 200, "ok", false, false],
    ["login", 503, "service unavailable", false, true],
    ["login", 522, "", false, true],
    ["login", 503, "error code: 1102", false, false],
  ] as const)("%s answered %i reads as ok=%s retry=%s", (check, status, body, ok, retry) => {
    expect(interpretSmoke(check, status, body)).toMatchObject({ ok, retry });
  });
});

describe("email to JobAdder support", () => {
  const url = "https://jobs-feed.example.com/";

  it("carries the URL, username and raw-XML ask, and never a password", () => {
    const pass = generatePassword();
    const email = jobadderEmail({ url, username: "jobadder-abcd2345", board: "12345" });
    expect(email).toContain("To:       support@jobadder.com");
    expect(email).toContain(url);
    expect(email).toContain("jobadder-abcd2345");
    expect(email).toContain("board 12345");
    expect(email).toMatch(/raw XML.*not form-encoded/);
    expect(email).toContain("sent separately");
    expect(email).not.toContain(pass);
    // Even handed one, the template has nowhere to put a password.
    expect(jobadderEmail({ url, username: "u", ...({ pass } as object) })).not.toContain(pass);
  });

  it("uses placeholders when the board or username is unknown", () => {
    const email = jobadderEmail({ url });
    expect(email).toContain("<BOARD_ID>");
    expect(email).toContain("<USERNAME>");
  });

  it("asks for an update, not a new setup, after --rotate", () => {
    const email = jobadderEmail({ url, username: "u", rotated: true });
    expect(email).toMatch(/New login/);
    expect(email).not.toMatch(/first push/);
  });

  it("rejects a board value that is not a board number", () => {
    expect(() => jobadderEmail({ url, board: "12345\nBcc: someone" })).toThrow(/board number/);
  });
});

describe("setup's reading of GET /status", () => {
  const live = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      service: "jobadder-feed-worker",
      version: "0.1.4",
      deployment: { id: "b90fb630-0000-4000-8000-000000000000", at: "2026-11-06T01:02:03.000Z" },
      feed_mode: "sync",
      config: "ok",
      jobs_fallback: "off",
      mass_removal_override: false,
      records: "ok",
      last_push: { at: "2026-11-06T00:00:00.000Z", sha256: "abcdef012345" },
      last_sync: { outcome: "ok", trigger: "push", at: "2026-11-06T00:00:05.000Z", jobs: 6, upserted: 6, removed: 0, held_removals: 0, published: true, ms: 4321 },
      ...overrides,
    });

  it("passes a healthy Worker and shows the release, deployment and last runs", () => {
    const { verdict, lines } = formatStatus(200, live(), "0.1.4");
    expect(verdict).toBe("pass");
    const text = lines.join("\n");
    expect(text).toContain("v0.1.4 (Cloudflare version b90fb630-0000-4000-8000-000000000000");
    expect(text).toContain("Mode:           sync");
    expect(text).toContain("Settings:       ok");
    expect(text).toContain("payload abcdef012345");
    expect(text).toContain("ok by push at 2026-11-06T00:00:05.000Z: 6 jobs, 6 written, 0 removed, published, 4321 ms");
  });

  it("fails on an invalid setting and names it", () => {
    const { verdict, lines } = formatStatus(200, live({ config: { invalid: "FRAMER_PROJECT_ID" } }), "0.1.4");
    expect(verdict).toBe("fail");
    expect(lines.join("\n")).toContain("INVALID: FRAMER_PROJECT_ID");
  });

  it("warns when the live release differs from this folder", () => {
    const { verdict, lines } = formatStatus(200, live({ version: "0.1.4" }), "0.1.5");
    expect(verdict).toBe("warn");
    expect(lines.join("\n")).toMatch(/this folder is v0\.1\.5, the live Worker is v0\.1\.4/);
  });

  it("reads a 404 as a release older than v0.1.4", () => {
    const { verdict, lines } = formatStatus(404, "not found", "0.1.4");
    expect(verdict).toBe("warn");
    expect(lines.join("\n")).toMatch(/older than v0\.1\.4/);
  });

  it("gives the override hash for a held sync", () => {
    const held = { outcome: "held", reason: "mass_removal_held", trigger: "cron", at: "2026-11-06T00:30:00.000Z", jobs: 1, held_removals: 5, sha256: "0123456789ab", ms: 900 };
    const { verdict, lines } = formatStatus(200, live({ last_sync: held }), "0.1.4");
    expect(verdict).toBe("warn");
    expect(lines.join("\n")).toContain("ALLOW_MASS_REMOVAL_SHA to 0123456789ab");
  });

  it("does not read missing records as no push", () => {
    const { verdict, lines } = formatStatus(200, live({ records: "unreadable", last_push: null, last_sync: null }), "0.1.4");
    expect(verdict).toBe("warn");
    expect(lines.join("\n")).toContain("not readable");
    expect(lines.join("\n")).not.toContain("none yet");
  });

  it("prints no control characters from the response", () => {
    const { lines } = formatStatus(200, live({ feed_mode: "sync\u001b[2J" }), "0.1.4");
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("does not trust a page that is not this Worker's", () => {
    expect(formatStatus(200, "<html>", "0.1.4").verdict).toBe("warn");
    expect(formatStatus(200, JSON.stringify({ service: "other" }), "0.1.4").verdict).toBe("warn");
  });
});

describe("carrying the live Worker's variables", () => {
  const VERSION_ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
  const status = (versions: unknown) => ({ id: "dep", versions });
  const version = (bindings: unknown) => ({ id: VERSION_ID, resources: { bindings } });

  it("treats only a missing Worker or one with no deployment as a first install", () => {
    expect(isNothingLive("✘ [ERROR] A request to the Cloudflare API failed.\n  This Worker does not exist on your account. [code: 10007]")).toBe(true);
    expect(isNothingLive("✘ [ERROR] The Worker example-worker has no deployments.")).toBe(true);
    expect(isNothingLive("✘ [ERROR] Authentication error [code: 10000]")).toBe(false);
    expect(isNothingLive("✘ [ERROR] fetch failed")).toBe(false);
    expect(isNothingLive("")).toBe(false);
  });

  it("takes the one version serving all traffic", () => {
    expect(activeVersionId(status([{ version_id: VERSION_ID, percentage: 100 }]))).toBe(VERSION_ID);
  });

  it("refuses a split deployment and anything not in the expected form", () => {
    expect(() => activeVersionId(status([{ version_id: VERSION_ID, percentage: 60 }, { version_id: VERSION_ID, percentage: 40 }]))).toThrow(/split/);
    expect(() => activeVersionId(status([{ version_id: VERSION_ID, percentage: 50 }]))).toThrow(/split/);
    expect(() => activeVersionId(status([]))).toThrow(/expected form/);
    expect(() => activeVersionId(null)).toThrow(/expected form/);
    expect(() => activeVersionId(status([{ version_id: "not an id", percentage: 100 }]))).toThrow(/version id/);
  });

  it("reads plain-text variables and ignores secrets and resource bindings", () => {
    const vars = liveVars(version([
      { type: "plain_text", name: "FEED_MODE", text: "sync" },
      { type: "plain_text", name: "HIRING_ORG_URL", text: "https://www.example.com/" },
      { type: "secret_text", name: "FEED_PASSWORD" },
      { type: "kv_namespace", name: "FEED_CAPTURE", namespace_id: "x" },
      { type: "version_metadata", name: "CF_VERSION_METADATA" },
    ]));
    expect(vars).toEqual({ FEED_MODE: "sync", HIRING_ORG_URL: "https://www.example.com/" });
  });

  it("stops on a JSON variable or an unrecognised shape rather than dropping it", () => {
    expect(() => liveVars(version([{ type: "json", name: "LIMITS", json: { a: 1 } }]))).toThrow(/JSON-typed.*LIMITS/);
    expect(() => liveVars({ resources: {} })).toThrow(/expected form/);
    expect(() => liveVars(version([{ type: "plain_text", name: "FEED_MODE" }]))).toThrow(/expected form/);
  });

  it("reads the tracked wrangler.jsonc vars and not its commented-out lines", () => {
    const vars = fileVars(trackedConfig);
    expect(vars["FEED_MODE"]).toBe("capture");
    expect(vars["FEED_AUTH_MODE"]).toBe("basic");
    expect(vars).not.toHaveProperty("FRAMER_PROJECT_ID");
    expect(vars).not.toHaveProperty(MASS_REMOVAL_SHA);
  });

  it("keeps // and /* inside strings and rejects an unreadable file", () => {
    expect(fileVars(`{ "vars": { "A": "https://x.example/a//b", "B": "/* no */" }, }`)).toEqual({ A: "https://x.example/a//b", B: "/* no */" });
    expect(() => fileVars("{ not json")).toThrow(/could not be read/);
  });

  it("carries every live variable, notes where the file differs, and lists new ones", () => {
    const file = { FEED_MODE: "capture", FEED_PATH: "/", NEW_SETTING: "on" };
    const live = { FEED_MODE: "sync", FEED_PATH: "/", JOB_COUNTRY: "XX" };
    const { carry, lines } = planVars(file, live, false);
    expect(carry).toEqual(live);
    expect(lines).toEqual([
      '  keep   FEED_MODE = "sync"   (wrangler.jsonc says "capture")',
      '  keep   FEED_PATH = "/"',
      '  keep   JOB_COUNTRY = "XX"',
      '  new    NEW_SETTING = "on"   (from wrangler.jsonc)',
    ]);
  });

  it("drops ALLOW_MASS_REMOVAL_SHA unless the deployer keeps it", () => {
    const live = { FEED_MODE: "sync", [MASS_REMOVAL_SHA]: "0123456789ab" };
    const dropped = planVars({}, live, false);
    expect(dropped.carry).toEqual({ FEED_MODE: "sync" });
    expect(dropped.lines).toContain(`  drop   ${MASS_REMOVAL_SHA} = "0123456789ab"`);
    expect(planVars({}, live, true).carry).toEqual(live);
  });

  it("shows a value with control characters escaped", () => {
    expect(planVars({}, { X: "a\u001b[2Jb\n" }, false).lines[0]).toBe('  keep   X = "a\\u001b[2Jb\\n"');
  });

  it("builds --var arguments that keep a URL whole and refuses an odd name", () => {
    expect(varArgs({ FEED_MODE: "sync", HIRING_ORG_URL: "https://www.example.com/" })).toEqual([
      "--var", "FEED_MODE:sync", "--var", "HIRING_ORG_URL:https://www.example.com/",
    ]);
    expect(varArgs({})).toEqual([]);
    expect(() => varArgs({ "BAD:NAME": "x" })).toThrow(/cannot be carried/);
  });
});
