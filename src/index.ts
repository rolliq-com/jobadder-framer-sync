import { authenticate } from "./auth";
import { readCappedBody } from "./body";
import { fallbackEnabled, loadConfig, settingName, type Config, type Env } from "./config";
import { handleJobs, isJobsRequest } from "./fallback";
import { connectFramer, type FramerConnector } from "./framer";
import { recordPush, recordSync } from "./health";
import { logRequest, logSync } from "./log";
import { storeCapture } from "./store";
import { handleStatus, isStatusRequest } from "./status";
import { reconcile, runSync, sha256Hex } from "./sync";
import { checkXml } from "./xml";

// Every response body is a fixed string. Nothing from the request is echoed.
function reply(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// Keeps only the media type token (no parameters), so nothing free-form from
// the request reaches storage or logs.
function mediaType(header: string | null): string {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type.slice(0, 100) : "none";
}

// What the Worker talks to outside Cloudflare. Tests pass a fake Framer client.
export interface Deps {
  connect: FramerConnector;
}

const defaultDeps: Deps = { connect: connectFramer };

export async function handleRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  deps: Deps = defaultDeps,
): Promise<Response> {
  // The public jobs fallback, only when switched on and only for GET, HEAD or
  // OPTIONS on its own path. Every other request, a POST to that path
  // included, takes the feed path below exactly as it would with the
  // fallback off.
  const url = new URL(request.url);
  if (fallbackEnabled(env) && isJobsRequest(request, url)) return handleJobs(request, env, url, ctx);

  // GET or HEAD /status, answered before the feed's settings are loaded so it
  // can report a broken one. Any other method on /status takes the feed path.
  if (isStatusRequest(request, url)) return handleStatus(request, env, url, ctx);

  const started = Date.now();
  const ms = () => Date.now() - started;
  const reject = (status: number, reason: string, body: string, headers?: Record<string, string>) => {
    logRequest({ outcome: "rejected", status, reason, ms: ms() });
    return reply(status, body, headers);
  };

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    logRequest({ outcome: "error", status: 503, reason: "misconfigured", setting: settingName(err), ms: ms() });
    return reply(503, "service unavailable");
  }

  // Never accept the feed over plain HTTP, and never redirect: a redirected
  // POST can be replayed as a GET and the credentials have already been sent.
  if (url.protocol !== "https:") return reject(403, "insecure_scheme", "https required");

  const auth = await authenticate(request, url, config.auth);
  if (!auth.ok) {
    // An unknown path reveals nothing, which is the whole point in path mode.
    if (auth.reason === "wrong_path") return reject(404, auth.reason, "not found");
    return reject(401, auth.reason, "unauthorized", { "WWW-Authenticate": 'Basic realm="feed", charset="UTF-8"' });
  }

  if (request.method !== "POST") return reject(405, "method_not_allowed", "method not allowed", { Allow: "POST" });

  const body = await readCappedBody(request, config.maxBodyBytes);
  if (!body.ok) {
    return body.reason === "too_large"
      ? reject(413, body.reason, "payload too large")
      : reject(400, body.reason, "bad request");
  }

  const contentType = mediaType(request.headers.get("Content-Type"));
  const xml = checkXml(body.bytes);
  if (!xml.ok) {
    logRequest({ outcome: "rejected", status: 400, reason: xml.reason, bytes: body.bytes.byteLength, contentType, ms: ms() });
    return reply(400, "bad request");
  }

  const metadata = {
    receivedAt: new Date().toISOString(),
    bytes: body.bytes.byteLength,
    sha256: await sha256Hex(body.bytes),
    contentType,
    root: xml.root,
  };

  try {
    await storeCapture(config.store, body.bytes, metadata);
  } catch {
    // A 5xx lets the sender retry.
    logRequest({ outcome: "error", status: 500, reason: "store_failed", bytes: metadata.bytes, ms: ms() });
    return reply(500, "internal error");
  }

  logRequest({
    outcome: "accepted",
    status: 200,
    bytes: metadata.bytes,
    root: metadata.root,
    contentType,
    sha256: metadata.sha256.slice(0, 12),
    ms: ms(),
  });

  // Sync mode: the push is stored and acknowledged first, then synced to the
  // site. A failed sync is recorded and retried by the cron; the sender is
  // never asked to push again for it. The push is recorded for GET /status
  // first, so it shows even if the sync is cut off; then the sync records its
  // own run. Neither write can fail the push.
  const store = config.store;
  const recorded = recordPush(store, { at: metadata.receivedAt, sha256: metadata.sha256.slice(0, 12) });
  const background = config.sync
    ? recorded.then(() =>
        runSync({
          config: { ...config, sync: config.sync! },
          payload: body.bytes,
          sha256: metadata.sha256,
          connect: deps.connect,
          trigger: "push",
        }).then((result) => recordSync(store, result)),
      )
    : recorded;
  if (ctx) ctx.waitUntil(background);
  else await background;
  return reply(200, "ok");
}

/** The Cron Trigger: in sync mode, re-runs the sync if the last one did not finish. */
export async function handleScheduled(env: Env, deps: Deps = defaultDeps): Promise<void> {
  // Capture mode has nothing to reconcile; its own setting errors show on the feed path.
  if (env.FEED_MODE !== "sync") return;
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    logSync({ outcome: "error", trigger: "cron", reason: "misconfigured", setting: settingName(err), ms: 0 });
    return;
  }
  if (!config.sync) return;
  await reconcile({ ...config, sync: config.sync }, deps.connect);
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env as Env, ctx),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(handleScheduled(env as Env)),
} satisfies ExportedHandler;
