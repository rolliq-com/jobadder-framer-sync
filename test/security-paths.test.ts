import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { readCappedBody } from "../src/body";
import type { Env } from "../src/config";
import { connectFramer } from "../src/framer";
import { handleRequest } from "../src/index";
import { CAPTURE_KEY } from "../src/store";
import { FEED_URL, FEED_XML, PASS, USER } from "./fixtures";

// Failure paths the other suites reach only indirectly: each one must refuse
// without storing anything, and the Framer client must never write into a
// collection it does not manage.

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("framer-api", () => ({ connect }));

const bindings = env as unknown as { FEED_CAPTURE: KVNamespace };

function basicEnv(): Env {
  return {
    FEED_MODE: "capture",
    FEED_AUTH_MODE: "basic",
    FEED_BASIC_AUTH_USER: USER,
    FEED_BASIC_AUTH_PASS: PASS,
    CAPTURE_STORE: "kv",
    CAPTURE_BINDING: "FEED_CAPTURE",
    FEED_CAPTURE: bindings.FEED_CAPTURE,
  };
}

let logSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
function lastLog(): Record<string, unknown> {
  return JSON.parse(String([...logSpy.mock.calls, ...errSpy.mock.calls].at(-1)![0]));
}
afterEach(async () => {
  vi.restoreAllMocks();
  connect.mockReset();
  await bindings.FEED_CAPTURE.delete(CAPTURE_KEY);
});

describe("credentials that are not valid UTF-8", () => {
  it("are refused as malformed with 401, and nothing is stored", async () => {
    // "\xff\xfe" is valid base64 input but not valid UTF-8 once decoded.
    const auth = "Basic " + btoa(`\xff\xfe${USER}:${PASS}`);
    const req = new Request(FEED_URL, { method: "POST", headers: { Authorization: auth }, body: FEED_XML });
    const res = await handleRequest(req, basicEnv());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
    expect(await bindings.FEED_CAPTURE.get(CAPTURE_KEY)).toBeNull();
    // Refused by the strict decoder, not by a lucky mismatch after lossy decoding.
    expect(lastLog()).toMatchObject({ outcome: "rejected", reason: "malformed_credentials" });
  });
});

describe("readCappedBody", () => {
  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const read = vi.fn();
    const request = {
      headers: new Headers({ "Content-Length": "101" }),
      body: { getReader: read },
    } as unknown as Request;
    expect(await readCappedBody(request, 100)).toEqual({ ok: false, reason: "too_large" });
    expect(read).not.toHaveBeenCalled();
  });

  it("does not trust a Content-Length that understates the body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(150));
        c.close();
      },
    });
    const request = { headers: new Headers({ "Content-Length": "10" }), body: stream } as unknown as Request;
    expect(await readCappedBody(request, 100)).toEqual({ ok: false, reason: "too_large" });
  });

  it("reports a body stream that fails mid-read as unreadable", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("connection reset"));
      },
    });
    const request = { headers: new Headers(), body: stream } as unknown as Request;
    expect(await readCappedBody(request, 100)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("answers an unreadable push with 400 and stores nothing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("connection reset"));
      },
    });
    const req = new Request(FEED_URL, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${USER}:${PASS}`) },
      body: stream,
    });
    const res = await handleRequest(req, basicEnv());
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad request");
    expect(await bindings.FEED_CAPTURE.get(CAPTURE_KEY)).toBeNull();
  });
});

describe("connectFramer", () => {
  function fakeClient(collections: { name: string; managedBy: string }[]) {
    const created = { setFields: vi.fn(), getItemIds: vi.fn(async () => []), addItems: vi.fn(), removeItems: vi.fn() };
    const client = {
      getManagedCollections: vi.fn(async () => collections.map((c) => ({ ...c, ...created }))),
      createManagedCollection: vi.fn(async () => created),
      publish: vi.fn(async () => ({ deployment: { id: "dep-1" } })),
      deploy: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    connect.mockResolvedValue(client);
    return { client, created };
  }

  it("passes the project id and key to the client as arguments, not in a URL", async () => {
    fakeClient([]);
    await connectFramer({ projectId: "abcdefghij0123456789", apiKey: "key-value" });
    expect(connect).toHaveBeenCalledWith("abcdefghij0123456789", "key-value");
  });

  it("refuses a same-named collection that another plugin or a user manages", async () => {
    for (const managedBy of ["user", "anotherPlugin"]) {
      const { client } = fakeClient([{ name: "Jobs", managedBy }]);
      const session = await connectFramer({ projectId: "abcdefghij0123456789", apiKey: "k" });
      await expect(session.managedCollection("Jobs")).rejects.toThrow("collection managed elsewhere");
      expect(client.createManagedCollection).not.toHaveBeenCalled();
    }
  });

  it("uses its own collection, and creates one only when none has the name", async () => {
    const own = fakeClient([{ name: "Jobs", managedBy: "thisPlugin" }]);
    await (await connectFramer({ projectId: "abcdefghij0123456789", apiKey: "k" })).managedCollection("Jobs");
    expect(own.client.createManagedCollection).not.toHaveBeenCalled();

    const none = fakeClient([{ name: "Other", managedBy: "thisPlugin" }]);
    await (await connectFramer({ projectId: "abcdefghij0123456789", apiKey: "k" })).managedCollection("Jobs");
    expect(none.client.createManagedCollection).toHaveBeenCalledWith("Jobs");
  });

  it("publishes, deploys that deployment, and disconnects through the client", async () => {
    const { client } = fakeClient([]);
    const session = await connectFramer({ projectId: "abcdefghij0123456789", apiKey: "k" });
    const { deploymentId } = await session.publish();
    await session.deploy(deploymentId);
    await session.disconnect();
    expect(client.deploy).toHaveBeenCalledWith("dep-1");
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
