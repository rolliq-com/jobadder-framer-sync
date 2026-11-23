import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { constantTimeEqual } from "../src/auth";
import type { Env } from "../src/config";
import { LAST_PUSH_KEY } from "../src/health";
import { handleRequest } from "../src/index";
import { CAPTURE_KEY, type CaptureMetadata } from "../src/store";
import { MAX_ROOT_NAME_LENGTH } from "../src/xml";
import { basicAuth, FEED_URL, FEED_XML, PASS, PATH_SECRET, USER } from "./fixtures";

const bindings = env as unknown as { FEED_CAPTURE: KVNamespace; FEED_CAPTURE_R2: R2Bucket };

function basicEnv(overrides: Partial<Env> = {}): Env {
  return {
    FEED_MODE: "capture",
    FEED_AUTH_MODE: "basic",
    FEED_BASIC_AUTH_USER: USER,
    FEED_BASIC_AUTH_PASS: PASS,
    CAPTURE_STORE: "kv",
    CAPTURE_BINDING: "FEED_CAPTURE",
    FEED_CAPTURE: bindings.FEED_CAPTURE,
    FEED_CAPTURE_R2: bindings.FEED_CAPTURE_R2,
    ...overrides,
  };
}

function pathEnv(overrides: Partial<Env> = {}): Env {
  return basicEnv({
    FEED_AUTH_MODE: "path",
    FEED_BASIC_AUTH_USER: undefined,
    FEED_BASIC_AUTH_PASS: undefined,
    FEED_PATH_SECRET: PATH_SECRET,
    ...overrides,
  });
}

function post(body: BodyInit | null, init: { url?: string; auth?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ "Content-Type": "application/xml", ...init.headers });
  const auth = init.auth === undefined ? basicAuth(USER, PASS) : init.auth;
  if (auth !== null) headers.set("Authorization", auth);
  return new Request(init.url ?? FEED_URL, { method: "POST", headers, body });
}

async function storedKv() {
  return bindings.FEED_CAPTURE.getWithMetadata<CaptureMetadata>(CAPTURE_KEY, "text");
}

let logSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of [CAPTURE_KEY, LAST_PUSH_KEY]) {
    await bindings.FEED_CAPTURE.delete(key);
    await bindings.FEED_CAPTURE_R2.delete(key);
  }
});

function logged(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(" ")).join("\n");
}
function lastLog(): Record<string, unknown> {
  const calls = [...logSpy.mock.calls, ...errSpy.mock.calls];
  return JSON.parse(String(calls.at(-1)![0]));
}

describe("capture, basic auth", () => {
  it("stores the raw payload in KV with metadata and returns 200", async () => {
    const res = await handleRequest(post(FEED_XML), basicEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const { value, metadata } = await storedKv();
    expect(value).toBe(FEED_XML);
    expect(metadata).toMatchObject({ root: "Jobs", contentType: "application/xml", bytes: new TextEncoder().encode(FEED_XML).byteLength });
    expect(metadata!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lastLog()).toMatchObject({ outcome: "accepted", status: 200, root: "Jobs" });
  });

  it("overwrites the previous capture so only the latest is kept", async () => {
    await handleRequest(post(FEED_XML), basicEnv());
    await handleRequest(post("<Jobs/>"), basicEnv());
    const list = await bindings.FEED_CAPTURE.list();
    // The capture, and the small record GET /status reads.
    expect(list.keys.map((k) => k.name)).toEqual([LAST_PUSH_KEY, CAPTURE_KEY]);
    expect((await storedKv()).value).toBe("<Jobs/>");
  });

  it("stores to R2 when configured", async () => {
    const res = await handleRequest(post(FEED_XML), basicEnv({ CAPTURE_STORE: "r2", CAPTURE_BINDING: "FEED_CAPTURE_R2" }));
    expect(res.status).toBe(200);
    const obj = await bindings.FEED_CAPTURE_R2.get(CAPTURE_KEY);
    expect(await obj!.text()).toBe(FEED_XML);
    expect(obj!.customMetadata).toMatchObject({ root: "Jobs" });
  });

  it("captures a well-formed payload with an unexpected root, and records the root", async () => {
    const res = await handleRequest(post("<?xml version=\"1.0\"?><!-- c --><Other><a/></Other>"), basicEnv());
    expect(res.status).toBe(200);
    expect((await storedKv()).metadata!.root).toBe("Other");
  });

  it("accepts a custom FEED_PATH and rejects other paths", async () => {
    const e = basicEnv({ FEED_PATH: "/jobs" });
    expect((await handleRequest(post(FEED_XML, { url: "https://feed.example.test/jobs" }), e)).status).toBe(200);
    expect((await handleRequest(post(FEED_XML), e)).status).toBe(404);
  });

  it.each([
    ["wrong password", basicAuth(USER, PASS + "x"), "bad_credentials"],
    ["wrong user", basicAuth("someone", PASS), "bad_credentials"],
    ["missing header", null, "no_credentials"],
    ["bearer scheme", "Bearer abc", "malformed_credentials"],
    ["bad base64", "Basic !!!", "malformed_credentials"],
    ["no colon", "Basic " + btoa("justauser"), "malformed_credentials"],
  ])("rejects %s with 401 and stores nothing", async (_name, auth, reason) => {
    const res = await handleRequest(post(FEED_XML, { auth }), basicEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
    expect(await res.text()).toBe("unauthorized");
    expect((await storedKv()).value).toBeNull();
    expect(lastLog()).toMatchObject({ outcome: "rejected", reason });
  });

  it("rejects plain HTTP with 403 even with valid credentials", async () => {
    const res = await handleRequest(post(FEED_XML, { url: "http://feed.example.test/" }), basicEnv());
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
    expect((await storedKv()).value).toBeNull();
  });

  it.each(["GET", "PUT", "DELETE"])("rejects %s with 405 after auth", async (method) => {
    const req = new Request(FEED_URL, {
      method,
      headers: { Authorization: basicAuth(USER, PASS) },
      body: method === "GET" ? null : FEED_XML,
    });
    const res = await handleRequest(req, basicEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("rejects an unauthenticated GET with 401, not 405", async () => {
    const res = await handleRequest(new Request(FEED_URL), basicEnv());
    expect(res.status).toBe(401);
  });

  it.each([
    ["lower-case scheme", "basic " + btoa(`${USER}:${PASS}`)],
    ["extra spaces", "Basic   " + btoa(`${USER}:${PASS}`) + "  "],
  ])("accepts %s in the Authorization header", async (_name, auth) => {
    expect((await handleRequest(post(FEED_XML, { auth }), basicEnv())).status).toBe(200);
  });

  it("splits the login at the first colon, so a password may contain one", async () => {
    const pass = PASS + ":colon";
    const res = await handleRequest(post(FEED_XML, { auth: basicAuth(USER, pass) }), basicEnv({ FEED_BASIC_AUTH_PASS: pass }));
    expect(res.status).toBe(200);
  });

  it("answers a cross-origin preflight with 401 and no CORS headers", async () => {
    const req = new Request(FEED_URL, {
      method: "OPTIONS",
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "POST" },
    });
    const res = await handleRequest(req, basicEnv());
    expect(res.status).toBe(401);
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });
});

describe("capture, path secret mode", () => {
  const url = `https://feed.example.test/${PATH_SECRET}`;

  it("accepts a POST to the secret path without basic auth", async () => {
    const res = await handleRequest(post(FEED_XML, { url, auth: null }), pathEnv());
    expect(res.status).toBe(200);
    expect((await storedKv()).value).toBe(FEED_XML);
  });

  it.each([
    ["root path", "https://feed.example.test/"],
    ["wrong secret", `https://feed.example.test/${PATH_SECRET.slice(0, -1)}x`],
    ["secret prefix", `https://feed.example.test/${PATH_SECRET.slice(0, 10)}`],
    ["secret plus suffix", `${url}/extra`],
  ])("rejects %s with 404 and stores nothing", async (_name, badUrl) => {
    const res = await handleRequest(post(FEED_XML, { url: badUrl }), pathEnv());
    expect(res.status).toBe(404);
    expect((await storedKv()).value).toBeNull();
  });

  it("rejects plain HTTP to the secret path", async () => {
    const res = await handleRequest(post(FEED_XML, { url: url.replace("https:", "http:"), auth: null }), pathEnv());
    expect(res.status).toBe(403);
  });

  it("never logs the path secret", async () => {
    await handleRequest(post(FEED_XML, { url, auth: null }), pathEnv());
    await handleRequest(post("<bad", { url, auth: null }), pathEnv());
    await handleRequest(post(FEED_XML, { url: url + "x" }), pathEnv());
    expect(logged()).not.toContain(PATH_SECRET);
    expect(logged()).not.toContain(PATH_SECRET.slice(0, 16));
  });
});

describe("payload validation", () => {
  it("rejects a body over MAX_BODY_BYTES by Content-Length with 413", async () => {
    const res = await handleRequest(post(FEED_XML), basicEnv({ MAX_BODY_BYTES: "100" }));
    expect(res.status).toBe(413);
    expect((await storedKv()).value).toBeNull();
  });

  it("rejects an oversized streamed body with no Content-Length with 413", async () => {
    const chunk = new TextEncoder().encode("<a>" + "x".repeat(60) + "</a>");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const req = post(stream);
    expect(req.headers.get("Content-Length")).toBeNull();
    const res = await handleRequest(req, basicEnv({ MAX_BODY_BYTES: 100 }));
    expect(res.status).toBe(413);
  });

  it.each([
    ["empty body", "", "empty"],
    ["unclosed tag", "<Jobs><Job></Jobs>", "malformed_xml"],
    ["not XML", "hello world", "malformed_xml"],
    ["form encoded", "xml=%3CJobs%2F%3E", "malformed_xml"],
    ["DOCTYPE", '<?xml version="1.0"?><!DOCTYPE Jobs [<!ENTITY a "aaaa">]><Jobs>&a;</Jobs>', "doctype_not_allowed"],
    ["two roots", "<Jobs/><Jobs/>", "malformed_xml"],
    ["text before the root", "junk<Jobs/>", "malformed_xml"],
    ["lower-case doctype", "<!doctype Jobs><Jobs/>", "doctype_not_allowed"],
    ["external entity", '<!DOCTYPE Jobs [<!ENTITY x SYSTEM "file:///etc/passwd">]><Jobs>&x;</Jobs>', "doctype_not_allowed"],
    ["billion laughs", '<!DOCTYPE l [<!ENTITY a "aa"><!ENTITY b "&a;&a;&a;">]><l>&b;</l>', "doctype_not_allowed"],
    ["deep nesting", "<a>".repeat(5000) + "</a>".repeat(5000), "malformed_xml"],
  ])("rejects %s with 400", async (_name, body, reason) => {
    const res = await handleRequest(post(body), basicEnv());
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad request");
    expect((await storedKv()).value).toBeNull();
    expect(lastLog()).toMatchObject({ reason });
  });

  it("rejects invalid UTF-8 with 400", async () => {
    const bytes = new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e]);
    const res = await handleRequest(post(bytes), basicEnv());
    expect(res.status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "not_utf8" });
  });

  it("accepts a UTF-8 BOM", async () => {
    const res = await handleRequest(post("﻿" + FEED_XML), basicEnv());
    expect(res.status).toBe(200);
  });

  it("stores an undeclared entity reference as-is, without expanding it", async () => {
    const res = await handleRequest(post("<Jobs>&xxe;</Jobs>"), basicEnv());
    expect(res.status).toBe(200);
    expect((await storedKv()).value).toBe("<Jobs>&xxe;</Jobs>");
  });

  it.each([
    ["KV", {}],
    ["R2", { CAPTURE_STORE: "r2", CAPTURE_BINDING: "FEED_CAPTURE_R2" }],
  ] as [string, Partial<Env>][])("stores a payload with an overlong root name in %s, recording a capped name", async (_name, overrides) => {
    const res = await handleRequest(post(`<${"R".repeat(5000)}/>`), basicEnv(overrides));
    expect(res.status).toBe(200);
    expect(lastLog()).toMatchObject({ outcome: "accepted", root: "R".repeat(MAX_ROOT_NAME_LENGTH) });
  });
});

describe("misconfiguration fails closed with 503", () => {
  it.each([
    ["missing user", { FEED_BASIC_AUTH_USER: undefined }, "FEED_BASIC_AUTH_USER"],
    ["missing password", { FEED_BASIC_AUTH_PASS: undefined }, "FEED_BASIC_AUTH_PASS"],
    ["short password", { FEED_BASIC_AUTH_PASS: "short" }, "FEED_BASIC_AUTH_PASS"],
    ["user with colon", { FEED_BASIC_AUTH_USER: "a:b" }, "FEED_BASIC_AUTH_USER"],
    ["unknown feed mode", { FEED_MODE: "mirror" }, "FEED_MODE"],
    ["unknown auth mode", { FEED_AUTH_MODE: "none" }, "FEED_AUTH_MODE"],
    ["unknown store", { CAPTURE_STORE: "d1" }, "CAPTURE_STORE"],
    ["missing binding", { CAPTURE_BINDING: "NOPE" }, "CAPTURE_BINDING"],
    ["prototype as binding", { CAPTURE_BINDING: "__proto__" }, "CAPTURE_BINDING"],
    ["binding that is not a store", { CAPTURE_BINDING: "ODD", ODD: {} }, "CAPTURE_BINDING"],
    ["bad size cap", { MAX_BODY_BYTES: "lots" }, "MAX_BODY_BYTES"],
    ["size cap above ceiling", { MAX_BODY_BYTES: "999999999" }, "MAX_BODY_BYTES"],
    ["relative FEED_PATH", { FEED_PATH: "jobs" }, "FEED_PATH"],
  ] as [string, Partial<Env>, string][])("%s", async (_name, overrides, setting) => {
    const res = await handleRequest(post(FEED_XML), basicEnv(overrides));
    expect(res.status).toBe(503);
    expect(lastLog()).toMatchObject({ outcome: "error", reason: "misconfigured", setting });
    expect(logged()).not.toContain(PASS);
    // Fails closed: a Worker deployed before its secrets are set stores nothing.
    expect((await storedKv()).value).toBeNull();
  });

  it.each([
    ["missing path secret", { FEED_PATH_SECRET: undefined }],
    ["short path secret", { FEED_PATH_SECRET: "tooShort" }],
    ["path secret with unsafe characters", { FEED_PATH_SECRET: "a/b".padEnd(40, "c") }],
  ] as [string, Partial<Env>][])("%s", async (_name, overrides) => {
    const res = await handleRequest(post(FEED_XML), pathEnv(overrides));
    expect(res.status).toBe(503);
    expect(lastLog()).toMatchObject({ setting: "FEED_PATH_SECRET" });
  });

  it("returns 500 when the store write fails, so the sender can retry", async () => {
    const broken = { put: () => Promise.reject(new Error("boom")) };
    const res = await handleRequest(post(FEED_XML), basicEnv({ FEED_CAPTURE: broken }));
    expect(res.status).toBe(500);
    expect(lastLog()).toMatchObject({ outcome: "error", reason: "store_failed" });
  });
});

describe("nothing from the request leaks into responses or logs", () => {
  const marker = "SENTINEL-applicant@example.com";
  const xml = `<Jobs><Job><Apply><EmailTo>${marker}</EmailTo></Apply></Job></Jobs>`;
  const cases: [string, () => Promise<Response>][] = [
    ["accepted", () => handleRequest(post(xml), basicEnv())],
    ["bad auth", () => handleRequest(post(xml, { auth: basicAuth(USER, marker) }), basicEnv())],
    ["malformed", () => handleRequest(post(xml + "<"), basicEnv())],
    ["too large", () => handleRequest(post(xml), basicEnv({ MAX_BODY_BYTES: 10 }))],
    ["odd content type", () => handleRequest(post(xml, { headers: { "Content-Type": `text/xml; x="${marker}"` } }), basicEnv())],
  ];

  it.each(cases)("%s", async (_name, run) => {
    const res = await run();
    const text = await res.text();
    expect(text).not.toContain(marker);
    expect(text).not.toContain(PASS);
    const logs = logged();
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain(PASS);
    expect(logs).not.toContain(USER);
    expect(logs).not.toContain("feed.example.test");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("constantTimeEqual", () => {
  it("matches equal strings and rejects different ones, including different lengths", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
    expect(await constantTimeEqual("", "a")).toBe(false);
  });
});
