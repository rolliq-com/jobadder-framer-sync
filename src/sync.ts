import type { Config, SyncConfig } from "./config";
import { JOB_FIELDS, toItem, type JobItem } from "./fields";
import type { FramerConnector, FramerSession } from "./framer";
import { parseJobs } from "./jobs";
import { recordSync } from "./health";
import { logSync, type SyncLogFields } from "./log";
import { readCapture, readStatus, writeStatus, type SyncStatus } from "./store";
import { version } from "../package.json";

// Sync mode: makes the site's Jobs collection match one stored feed payload.
// The payload is the desired state: every job in it is upserted by ad id,
// every item not in it is removed, and the site is published and deployed
// only when something was written. Two guards stop a bad push from wiping the
// site: a payload whose every ad was rejected is refused (an empty <Jobs/> is
// a board with no live ads, not a refusal), and removals above a share
// of the collection are held when there are also at least a minimum number of
// them (so routine expiries on a small board still go through).

export type SyncTrigger = "push" | "cron";

// Fixed reason codes. An error's message is never logged or stored: it can
// carry a URL or the key.
type Step = "framer_connect" | "framer_write" | "framer_publish" | "framer_deploy";

interface RunOptions {
  config: Config & { sync: SyncConfig };
  payload: Uint8Array;
  sha256: string;
  connect: FramerConnector;
  trigger: SyncTrigger;
}

/** Runs one sync and writes its status. Never throws; the result is also logged. */
export async function runSync(options: RunOptions): Promise<SyncLogFields> {
  const started = Date.now();
  let fields: Omit<SyncLogFields, "trigger" | "ms">;
  try {
    fields = await sync(options);
  } catch {
    // Building the items or closing the session threw outside the steps
    // above. Still one logged line with a fixed code, never the message.
    fields = { outcome: "error", reason: "internal" };
  }
  const result = { ...fields, trigger: options.trigger, sha256: options.sha256.slice(0, 12), ms: Date.now() - started };
  logSync(result);
  return result;
}

async function sync({ config, payload, sha256, connect }: RunOptions): Promise<Omit<SyncLogFields, "trigger" | "ms">> {
  const { store, sync: settings } = config;

  let previous: SyncStatus | null;
  try {
    previous = await readStatus(store);
  } catch {
    return { outcome: "error", reason: "store_failed" };
  }
  const record = async (status: Omit<SyncStatus, "sha256" | "at" | "version">) => {
    await writeStatus(store, { sha256, at: new Date().toISOString(), version, ...status });
  };

  // Refused payloads touch nothing on the site.
  const parsed = parseJobs(payload);
  const refusal = !parsed.ok
    ? parsed.reason
    : parsed.jobs.length === 0 && parsed.rejected.length > 0
      ? "no_usable_jobs"
      : undefined;
  if (refusal || !parsed.ok) {
    const rejected = parsed.ok ? parsed.rejected.length : undefined;
    try {
      await record({ ...carried(previous), outcome: "refused", reason: refusal, jobs: 0 });
    } catch {
      return { outcome: "error", reason: "store_failed", rejected };
    }
    return { outcome: "refused", reason: refusal, jobs: 0, rejected };
  }

  const items: JobItem[] = [];
  const hashes: Record<string, string> = {};
  for (const job of parsed.jobs) {
    const item = await toItem(job, settings.jsonLd);
    items.push(item);
    hashes[item.id] = await itemHash(item);
  }
  const counts = { jobs: items.length, rejected: parsed.rejected.length };

  let step: Step = "framer_connect";
  let session: FramerSession | undefined;
  let wrote = false;
  let published = false;
  let upserted = 0;
  let removed = 0;
  let heldRemovals = 0;
  try {
    session = await connect({ projectId: settings.projectId, apiKey: settings.apiKey });
    const collection = await session.managedCollection(settings.collectionName);

    step = "framer_write";
    await collection.setFields(JOB_FIELDS);
    const current = new Set(await collection.getItemIds());
    const wanted = new Set(items.map((item) => item.id));

    // A job is written when the site lacks it or it changed since last written.
    const upserts = items.filter((item) => !current.has(item.id) || previous?.items[item.id] !== hashes[item.id]);
    const removals = [...current].filter((id) => !wanted.has(id));

    const overridden = settings.allowMassRemovalSha === sha256.slice(0, 12);
    const held =
      removals.length >= settings.massRemovalMinItems &&
      removals.length / current.size > settings.maxRemovalFraction &&
      !overridden;

    if (upserts.length) {
      await collection.addItems(upserts);
      wrote = true;
      upserted = upserts.length;
    }
    if (held) {
      heldRemovals = removals.length;
    } else if (removals.length) {
      await collection.removeItems(removals);
      wrote = true;
      removed = removals.length;
    }

    // Writes are not live until published and deployed. An earlier run that
    // wrote but failed to publish is finished here too.
    if (wrote || previous?.unpublished) {
      step = "framer_publish";
      const { deploymentId } = await session.publish();
      step = "framer_deploy";
      await session.deploy(deploymentId);
      published = true;
    }

    const outcome = held ? "held" : "ok";
    const reason = held ? "mass_removal_held" : undefined;
    try {
      await record({ outcome, reason, jobs: items.length, items: hashes, unpublished: false });
    } catch {
      return { outcome: "error", reason: "store_failed", ...counts, upserted, removed, heldRemovals, published };
    }
    return { outcome, reason, ...counts, upserted, removed, heldRemovals, published };
  } catch {
    const reason = step;
    try {
      // Keep the previous item hashes: whatever this run wrote is written
      // again, and published, on the retry.
      await record({
        ...carried(previous),
        outcome: "error",
        reason,
        jobs: items.length,
        unpublished: Boolean(previous?.unpublished) || wrote,
      });
    } catch {
      // The error below is already the outcome; the cron retries either way.
    }
    return { outcome: "error", reason, ...counts, upserted, removed, heldRemovals, published };
  } finally {
    if (session) await session.disconnect().catch(() => {});
  }
}

function carried(previous: SyncStatus | null): Pick<SyncStatus, "items" | "unpublished"> {
  return { items: previous?.items ?? {}, unpublished: previous?.unpublished ?? false };
}

async function itemHash(item: JobItem): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(JSON.stringify(item)))).slice(0, 32);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The cron's reconcile: re-runs the sync on the stored payload unless this
 * release already finished on it. A Framer error or held removals are tried
 * again every time, so an outage heals and a hold keeps being reported. A new
 * release re-syncs once, so a change in how ads are written goes live without
 * waiting for a push; the per-item hashes still mean only changed ads are written.
 */
export async function reconcile(config: Config & { sync: SyncConfig }, connect: FramerConnector): Promise<SyncLogFields> {
  const started = Date.now();
  const skip = (reason: string, sha?: string): SyncLogFields => {
    const fields: SyncLogFields = { outcome: "skipped", trigger: "cron", reason, sha256: sha?.slice(0, 12), ms: Date.now() - started };
    logSync(fields);
    return fields;
  };

  let capture: Awaited<ReturnType<typeof readCapture>>;
  let status: SyncStatus | null;
  try {
    capture = await readCapture(config.store);
    status = await readStatus(config.store);
  } catch {
    const fields: SyncLogFields = { outcome: "error", trigger: "cron", reason: "store_failed", ms: Date.now() - started };
    logSync(fields);
    return fields;
  }
  if (!capture) return skip("no_capture");
  const sha256 = capture.sha256 && /^[0-9a-f]{64}$/.test(capture.sha256) ? capture.sha256 : await sha256Hex(capture.payload);
  if (status?.sha256 === sha256 && status.version === version && (status.outcome === "ok" || status.outcome === "refused")) {
    return skip("up_to_date", sha256);
  }
  const result = await runSync({ config, payload: capture.payload, sha256, connect, trigger: "cron" });
  // Recorded for GET /status. The skips above are not runs and write nothing.
  await recordSync(config.store, result);
  return result;
}
