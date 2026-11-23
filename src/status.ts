import { version } from "../package.json";
import { fallbackEnabled, loadConfig, loadFallback, loadStore, settingName, type Env } from "./config";
import { readHealth, type Health } from "./health";
import { logStatusRequest, type StatusLogFields } from "./log";

// GET /status: a public, unauthenticated summary of the live Worker, so whoever
// supports it can check it from outside the client's Cloudflare account. It
// says which release is running, which mode it is in, whether its settings are
// valid, and when the last push and sync happened.
//
// Public by design, so it carries no secret, no setting's value (only the name
// of an invalid one), no auth detail, no hostname and no job text. Nothing in it
// depends on the path-mode secret, and its own path can never equal that secret
// path (the secret is at least 32 characters). Only GET and HEAD are answered
// here: any other method on /status takes the feed path unchanged.

export const STATUS_PATH = "/status";
export const STATUS_METHODS = ["GET", "HEAD"];
export const STATUS_CACHE_SECONDS = 30;

export type Setting = "ok" | { invalid: string };

export interface StatusBody {
  service: "jobadder-feed-worker";
  version: string;
  deployment: { id: string; at: string } | null;
  feed_mode: "capture" | "sync" | "invalid";
  config: Setting;
  jobs_fallback: "off" | Setting;
  mass_removal_override: boolean;
  // Whether last_push and last_sync could be read: "ok", "unreadable" (the
  // store failed, so their nulls say nothing) or "unset" (no valid binding).
  records: "ok" | "unreadable" | "unset";
  last_push: Health["last_push"];
  last_sync: Health["last_sync"];
}

export function isStatusRequest(request: Request, url: URL): boolean {
  return url.pathname === STATUS_PATH && STATUS_METHODS.includes(request.method);
}

function check(load: () => unknown): Setting {
  try {
    load();
    return "ok";
  } catch (err) {
    return { invalid: settingName(err) };
  }
}

// The Cloudflare version this request runs on (wrangler.jsonc version_metadata).
// A dashboard edit to a variable makes a new one as well, so it changes when
// either the code or the settings change.
function deployment(env: Env): StatusBody["deployment"] {
  const meta = env.CF_VERSION_METADATA;
  if (!meta || typeof meta.id !== "string") return null;
  const at = typeof meta.timestamp === "string" ? meta.timestamp : "";
  return { id: meta.id.slice(0, 64), at: at.slice(0, 40) };
}

export async function handleStatus(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const log = (fields: Omit<StatusLogFields, "ms">) => logStatusRequest({ ...fields, ms: Date.now() - started });

  if (url.protocol !== "https:") {
    log({ outcome: "rejected", status: 403, reason: "insecure_scheme" });
    return new Response("https required", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const head = request.method === "HEAD";
  const withoutBody = (res: Response) => (head ? new Response(null, { status: res.status, headers: res.headers }) : res);

  // One cache entry per hostname and deployment, whatever the query string: the
  // query cannot bust the cache, so the store is read at most once per
  // STATUS_CACHE_SECONDS per location, and a new deployment (code or settings)
  // is shown at once rather than after the old entry expires.
  const deployed = deployment(env);
  const cacheKey = new Request(`https://${url.host}${STATUS_PATH}?v=${encodeURIComponent(deployed?.id ?? "none")}`, {
    method: "GET",
  });
  const cache = caches.default;
  // A cache fault only costs a store read, as on /jobs.json.
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) {
    log({ outcome: "served", status: 200, cache: "hit" });
    return withoutBody(cached);
  }

  const mode = env.FEED_MODE ?? "capture";
  let health: Health = { last_push: null, last_sync: null };
  let records: StatusBody["records"] = "ok";
  let store: ReturnType<typeof loadStore> | undefined;
  try {
    store = loadStore(env);
  } catch {
    // A broken store binding is named in "config".
    records = "unset";
  }
  if (store) {
    try {
      health = await readHealth(store);
    } catch {
      records = "unreadable";
    }
  }

  const body: StatusBody = {
    service: "jobadder-feed-worker",
    version,
    deployment: deployed,
    feed_mode: mode === "capture" || mode === "sync" ? mode : "invalid",
    config: check(() => loadConfig(env)),
    jobs_fallback: fallbackEnabled(env) ? check(() => loadFallback(env)) : "off",
    mass_removal_override: Boolean(env.ALLOW_MASS_REMOVAL_SHA),
    records,
    last_push: health.last_push,
    last_sync: health.last_sync,
  };

  const res = new Response(JSON.stringify(body, null, 2) + "\n", {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${STATUS_CACHE_SECONDS}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
  // A failed store read is not cached, so the next request tries again.
  if (records !== "unreadable") {
    const stored = cache.put(cacheKey, res.clone()).catch(() => {});
    if (ctx) ctx.waitUntil(stored);
    else await stored;
  }
  log({ outcome: "served", status: 200, cache: "miss", ...(records === "unreadable" ? { reason: "store_failed" } : {}) });
  return withoutBody(res);
}
