import type { Config } from "./config";

// Only the latest payload is kept: each push overwrites this key.
export const CAPTURE_KEY = "latest.xml";

export interface CaptureMetadata {
  receivedAt: string;
  bytes: number;
  sha256: string;
  contentType: string;
  root: string;
}

export async function storeCapture(
  store: Config["store"],
  payload: Uint8Array,
  metadata: CaptureMetadata,
): Promise<void> {
  if (store.kind === "kv") {
    await (store.binding as KVNamespace).put(CAPTURE_KEY, payload, { metadata });
    return;
  }
  await (store.binding as R2Bucket).put(CAPTURE_KEY, payload, {
    httpMetadata: { contentType: "application/xml" },
    customMetadata: { ...metadata, bytes: String(metadata.bytes) },
  });
}

/** The latest stored payload, when it arrived and its hash, or null before the first push. */
export async function readCapture(
  store: Config["store"],
): Promise<{ payload: Uint8Array; receivedAt?: string; sha256?: string } | null> {
  if (store.kind === "kv") {
    const { value, metadata } = await (store.binding as KVNamespace).getWithMetadata<Partial<CaptureMetadata>>(
      CAPTURE_KEY,
      "arrayBuffer",
    );
    return value ? { payload: new Uint8Array(value), receivedAt: metadata?.receivedAt, sha256: metadata?.sha256 } : null;
  }
  const object = await (store.binding as R2Bucket).get(CAPTURE_KEY);
  if (!object) return null;
  return {
    payload: new Uint8Array(await object.arrayBuffer()),
    receivedAt: object.customMetadata?.receivedAt,
    sha256: object.customMetadata?.sha256,
  };
}

// The sync's own record, next to the payload. Counts, reason codes and item
// hashes only: no job text.
export const STATUS_KEY = "status.json";

export interface SyncStatus {
  // The payload this sync ran on.
  sha256: string;
  outcome: "ok" | "held" | "refused" | "error";
  reason?: string;
  at: string;
  jobs: number;
  // Item id to a hash of the item as last written, so an unchanged job is not
  // written (or published) again.
  items: Record<string, string>;
  // Items were written but the site was not deployed: the next run publishes.
  unpublished?: boolean;
}

/** A small JSON record under `key`, as text, or null if there is none. Throws if the store fails. */
export async function readText(store: Config["store"], key: string): Promise<string | null> {
  if (store.kind === "kv") return (store.binding as KVNamespace).get(key, "text");
  return (await (await (store.binding as R2Bucket).get(key))?.text()) ?? null;
}

/** Writes a small JSON record under `key`. Throws if the store fails. */
export async function writeText(store: Config["store"], key: string, text: string): Promise<void> {
  if (store.kind === "kv") {
    await (store.binding as KVNamespace).put(key, text);
    return;
  }
  await (store.binding as R2Bucket).put(key, text, { httpMetadata: { contentType: "application/json" } });
}

export async function readStatus(store: Config["store"]): Promise<SyncStatus | null> {
  const text = await readText(store, STATUS_KEY);
  if (!text) return null;
  try {
    return JSON.parse(text) as SyncStatus;
  } catch {
    return null;
  }
}

export async function writeStatus(store: Config["store"], status: SyncStatus): Promise<void> {
  await writeText(store, STATUS_KEY, JSON.stringify(status));
}
