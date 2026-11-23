import { loadFallback, settingName, type FallbackConfig, type Env } from "./config";
import { jobSlug, parseJobs, type Job } from "./jobs";
import { logJobsRequest, type JobsLogFields } from "./log";
import { readCapture } from "./store";

// The public jobs fallback: GET /jobs.json, a read-only
// list of the live ads built from the latest stored push, for the site's
// JobsFallback component to render if the CMS sync is unavailable. Off unless
// JOBS_FALLBACK is "on". It never touches the feed's auth or its POST path.
//
// The list is public by design (every ad is already public on the board).
// CORS limits which site's scripts may read it in a browser; it is not access
// control.

export const JOBS_PATH = "/jobs.json";
export const JOBS_METHODS = ["GET", "HEAD", "OPTIONS"];
export const JOBS_CACHE_SECONDS = 300;

// The fields each job carries, in output order. The JobsFallback component
// reads only these. Add to this list, never rename or remove: the component
// on the live site binds to them. Left out on purpose: the description HTML
// (the component renders text only), salary (the client's call) and the
// internal reference. Apply/EmailTo is never read by the parser at all.
export const FALLBACK_JOB_FIELDS = [
  "id",
  "slug",
  "title",
  "summary",
  "highlights",
  "category",
  "subCategory",
  "location",
  "workType",
  "datePosted",
  "featured",
  "applyUrl",
] as const;

export type FallbackJob = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  highlights: string[];
  category: string | null;
  subCategory: string | null;
  location: string | null;
  workType: string | null;
  datePosted: string | null;
  featured: boolean;
  applyUrl: string;
};

export interface FallbackBody {
  updatedAt: string | null;
  jobs: FallbackJob[];
}

export function toFallbackJob(job: Job): FallbackJob {
  return {
    id: job.id,
    slug: jobSlug(job),
    title: job.title,
    summary: job.summary,
    highlights: job.highlights,
    category: job.category ?? null,
    subCategory: job.subCategory ?? null,
    location: job.location ?? null,
    workType: job.workType ?? null,
    datePosted: job.datePosted?.slice(0, 10) ?? null,
    featured: job.featured,
    applyUrl: job.applyUrl,
  };
}

/** Whether this request is for the fallback (the caller has checked it is on). */
export function isJobsRequest(request: Request, url: URL): boolean {
  return url.pathname === JOBS_PATH && JOBS_METHODS.includes(request.method);
}

export async function handleJobs(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const log = (fields: Omit<JobsLogFields, "ms">) => logJobsRequest({ ...fields, ms: Date.now() - started });
  const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
    });

  let config: FallbackConfig;
  try {
    config = loadFallback(env);
  } catch (err) {
    log({ outcome: "error", status: 503, reason: "misconfigured", setting: settingName(err) });
    return plain(503, "service unavailable");
  }

  if (url.protocol !== "https:") {
    log({ outcome: "rejected", status: 403, reason: "insecure_scheme" });
    return plain(403, "https required");
  }

  const cors = {
    "Access-Control-Allow-Origin": config.siteOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };

  if (request.method === "OPTIONS") {
    log({ outcome: "served", status: 204 });
    return new Response(null, { status: 204, headers: { ...cors, "Cache-Control": "no-store" } });
  }

  const head = request.method === "HEAD";
  const withoutBody = (res: Response) => (head ? new Response(null, { status: res.status, headers: res.headers }) : res);

  // One cache entry per hostname, whatever the query string.
  const cacheKey = new Request(`https://${url.host}${JOBS_PATH}`, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    log({ outcome: "served", status: 200, cache: "hit" });
    return withoutBody(cached);
  }

  let capture: Awaited<ReturnType<typeof readCapture>>;
  try {
    capture = await readCapture(config.store);
  } catch {
    log({ outcome: "error", status: 503, reason: "store_failed" });
    return plain(503, "service unavailable");
  }
  if (!capture) {
    log({ outcome: "error", status: 503, reason: "no_capture" });
    return plain(503, "service unavailable");
  }

  const parsed = parseJobs(capture.payload);
  if (!parsed.ok) {
    log({ outcome: "error", status: 503, reason: parsed.reason });
    return plain(503, "service unavailable");
  }

  const body: FallbackBody = {
    updatedAt: capture.receivedAt ?? null,
    jobs: parsed.jobs.map(toFallbackJob),
  };
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${JOBS_CACHE_SECONDS}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
  const stored = cache.put(cacheKey, res.clone()).catch(() => {});
  if (ctx) ctx.waitUntil(stored);
  else await stored;

  log({ outcome: "served", status: 200, cache: "miss", jobs: body.jobs.length });
  return withoutBody(res);
}
