import type { Config } from "./config";
import type { SyncLogFields } from "./log";
import { readText, writeText } from "./store";

// Two small records, kept beside the capture so GET /status can answer with two
// small reads (never the payload, which can be megabytes, or the sync's item
// map). Timestamps, counts, reason codes and a 12-character payload hash only:
// no job text.
//
// The push and the sync each own one record and write it whole, never read it
// first. The push is recorded as soon as it is stored, so a sync that is cut
// off still leaves the push visible; and the two writers never overwrite each
// other's record.
export const LAST_PUSH_KEY = "last-push.json";
export const LAST_SYNC_KEY = "last-sync.json";

export interface LastPush {
  at: string;
  sha256: string;
}

export interface LastSync {
  outcome: "ok" | "held" | "refused" | "error";
  trigger: "push" | "cron";
  at: string;
  reason?: string;
  jobs?: number;
  rejected?: number;
  upserted?: number;
  removed?: number;
  held_removals?: number;
  published?: boolean;
  sha256?: string;
  ms: number;
}

export interface Health {
  last_push: LastPush | null;
  last_sync: LastSync | null;
}

/** Records an accepted push. Never throws: it must not change the push's answer. */
export async function recordPush(store: Config["store"], push: LastPush): Promise<void> {
  await writeText(store, LAST_PUSH_KEY, JSON.stringify(push)).catch(() => {});
}

/** Records a sync run from its log line. A skip is not a run and is not recorded. Never throws. */
export async function recordSync(store: Config["store"], fields: SyncLogFields): Promise<void> {
  if (fields.outcome === "skipped") return;
  const record: LastSync = {
    outcome: fields.outcome,
    trigger: fields.trigger,
    at: new Date().toISOString(),
    reason: fields.reason,
    jobs: fields.jobs,
    rejected: fields.rejected,
    upserted: fields.upserted,
    removed: fields.removed,
    held_removals: fields.heldRemovals,
    published: fields.published,
    sha256: fields.sha256,
    ms: fields.ms,
  };
  await writeText(store, LAST_SYNC_KEY, JSON.stringify(record)).catch(() => {});
}

/** Both records, null where there is none yet. Throws if the store cannot be read. */
export async function readHealth(store: Config["store"]): Promise<Health> {
  const [push, sync] = await Promise.all([readText(store, LAST_PUSH_KEY), readText(store, LAST_SYNC_KEY)]);
  return { last_push: pickPush(parse(push)), last_sync: pickSync(parse(sync)) };
}

function parse(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// The records are this Worker's own, but /status is public: only known fields
// of the expected types are passed on, whatever the stored JSON holds.
const SHA12 = /^[0-9a-f]{12}$/;
const CODE = /^[a-z_]{1,40}$/;

function str(value: unknown, pattern?: RegExp): string | undefined {
  return typeof value === "string" && value.length <= 40 && (!pattern || pattern.test(value)) ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function isoTime(value: unknown): string | undefined {
  const s = str(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

function pickPush(value: unknown): LastPush | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const at = isoTime(v.at);
  const sha256 = str(v.sha256, SHA12);
  return at && sha256 ? { at, sha256 } : null;
}

const OUTCOMES = ["ok", "held", "refused", "error"];
const TRIGGERS = ["push", "cron"];

function pickSync(value: unknown): LastSync | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const outcome = str(v.outcome);
  const trigger = str(v.trigger);
  const at = isoTime(v.at);
  const ms = count(v.ms);
  if (!outcome || !OUTCOMES.includes(outcome) || !trigger || !TRIGGERS.includes(trigger) || !at || ms === undefined) {
    return null;
  }
  return {
    outcome: outcome as LastSync["outcome"],
    trigger: trigger as LastSync["trigger"],
    at,
    reason: str(v.reason, CODE),
    jobs: count(v.jobs),
    rejected: count(v.rejected),
    upserted: count(v.upserted),
    removed: count(v.removed),
    held_removals: count(v.held_removals),
    published: typeof v.published === "boolean" ? v.published : undefined,
    sha256: str(v.sha256, SHA12),
    ms,
  };
}
