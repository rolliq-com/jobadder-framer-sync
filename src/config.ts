// Runtime configuration, read from Worker vars and secrets on every request.
// Any problem fails closed: the Worker answers 503 and logs which setting is
// wrong, never its value.

import type { JobPostingOptions } from "./jsonld";

export type FeedMode = "capture" | "sync";
export type AuthMode = "basic" | "path";
export type StoreKind = "kv" | "r2";

export interface Env {
  FEED_MODE?: string;
  FEED_AUTH_MODE?: string;
  FEED_PATH?: string;
  MAX_BODY_BYTES?: string | number;
  CAPTURE_STORE?: string;
  CAPTURE_BINDING?: string;
  JOBS_FALLBACK?: string;
  SITE_ORIGIN?: string;
  // Sync mode
  FRAMER_PROJECT_ID?: string;
  FRAMER_COLLECTION_NAME?: string;
  MAX_REMOVAL_FRACTION?: string | number;
  MASS_REMOVAL_MIN_ITEMS?: string | number;
  ALLOW_MASS_REMOVAL_SHA?: string;
  HIRING_ORG_NAME?: string;
  HIRING_ORG_URL?: string;
  JOB_COUNTRY?: string;
  SALARY_CURRENCY?: string;
  // Secrets
  FEED_BASIC_AUTH_USER?: string;
  FEED_BASIC_AUTH_PASS?: string;
  FEED_PATH_SECRET?: string;
  FRAMER_API_KEY?: string;
  // The version_metadata binding (wrangler.jsonc): the Cloudflare version id.
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  // The capture binding, under whatever name CAPTURE_BINDING gives it
  [binding: string]: unknown;
}

export type AuthConfig =
  | { mode: "basic"; path: string; user: string; pass: string }
  | { mode: "path"; secret: string };

export interface Config {
  feedMode: FeedMode;
  auth: AuthConfig;
  maxBodyBytes: number;
  store: { kind: StoreKind; binding: unknown };
  // Present in sync mode only.
  sync?: SyncConfig;
}

export interface SyncConfig {
  projectId: string;
  apiKey: string;
  collectionName: string;
  // Removals are held when they are above this share of the collection's
  // items and at least massRemovalMinItems in number. Both must hold.
  maxRemovalFraction: number;
  // Fewer removals than this are never held, so routine expiries on a small
  // board go through. 1 holds on the share alone.
  massRemovalMinItems: number;
  // The first 12 hex characters of one payload's sha256: that payload alone
  // may remove more than maxRemovalFraction.
  allowMassRemovalSha?: string;
  jsonLd: JobPostingOptions;
}

export const DEFAULT_COLLECTION_NAME = "Jobs";
export const DEFAULT_MAX_REMOVAL_FRACTION = 0.5;
export const DEFAULT_MASS_REMOVAL_MIN_ITEMS = 3;
export const MASS_REMOVAL_MIN_ITEMS_CEILING = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 5_000_000;
// Hard ceiling: KV values top out at 25 MiB, and a job feed is far smaller.
export const MAX_BODY_BYTES_CEILING = 20_000_000;
export const MIN_PASSWORD_LENGTH = 24;
export const MIN_PATH_SECRET_LENGTH = 32;
const PATH_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(readonly setting: string) {
    super(`invalid setting: ${setting}`);
  }
}

/** The setting a configuration error names, for logs and GET /status. Never a value. */
export function settingName(err: unknown): string {
  return err instanceof ConfigError ? err.setting : "unknown";
}

export function loadConfig(env: Env): Config {
  const feedMode = env.FEED_MODE ?? "capture";
  if (feedMode !== "capture" && feedMode !== "sync") throw new ConfigError("FEED_MODE");

  return {
    feedMode,
    auth: loadAuth(env),
    maxBodyBytes: loadMaxBodyBytes(env.MAX_BODY_BYTES),
    store: loadStore(env),
    ...(feedMode === "sync" ? { sync: loadSync(env) } : {}),
  };
}

// The bare project id framer-api accepts: the 20 characters after "--" in
// the project URL. The name part before "--" is left out of configuration.
const PROJECT_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
const SHA_PREFIX_PATTERN = /^[0-9a-f]{12}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function loadSync(env: Env): SyncConfig {
  const apiKey = env.FRAMER_API_KEY;
  if (!apiKey) throw new ConfigError("FRAMER_API_KEY");
  const projectId = env.FRAMER_PROJECT_ID;
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) throw new ConfigError("FRAMER_PROJECT_ID");
  const collectionName = env.FRAMER_COLLECTION_NAME ?? DEFAULT_COLLECTION_NAME;
  if (!collectionName.trim() || collectionName.length > 100) throw new ConfigError("FRAMER_COLLECTION_NAME");

  const allowMassRemovalSha = env.ALLOW_MASS_REMOVAL_SHA || undefined;
  if (allowMassRemovalSha !== undefined && !SHA_PREFIX_PATTERN.test(allowMassRemovalSha)) {
    throw new ConfigError("ALLOW_MASS_REMOVAL_SHA");
  }

  const name = env.HIRING_ORG_NAME?.trim();
  if (!name) throw new ConfigError("HIRING_ORG_NAME");
  let url: string | undefined;
  if (env.HIRING_ORG_URL) {
    try {
      const parsed = new URL(env.HIRING_ORG_URL);
      if (parsed.protocol === "https:") url = parsed.href;
    } catch {
      url = undefined;
    }
    if (!url) throw new ConfigError("HIRING_ORG_URL");
  }
  const country = env.JOB_COUNTRY;
  if (!country || !COUNTRY_PATTERN.test(country)) throw new ConfigError("JOB_COUNTRY");
  const currency = env.SALARY_CURRENCY || undefined;
  if (currency !== undefined && !CURRENCY_PATTERN.test(currency)) throw new ConfigError("SALARY_CURRENCY");

  return {
    projectId,
    apiKey,
    collectionName,
    maxRemovalFraction: loadFraction(env.MAX_REMOVAL_FRACTION),
    massRemovalMinItems: loadMinItems(env.MASS_REMOVAL_MIN_ITEMS),
    allowMassRemovalSha,
    jsonLd: {
      organisation: url ? { name, url } : { name },
      country,
      ...(currency ? { salary: { currency } } : {}),
    },
  };
}

function loadFraction(raw: string | number | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MAX_REMOVAL_FRACTION;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new ConfigError("MAX_REMOVAL_FRACTION");
  return n;
}

function loadMinItems(raw: string | number | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MASS_REMOVAL_MIN_ITEMS;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MASS_REMOVAL_MIN_ITEMS_CEILING) {
    throw new ConfigError("MASS_REMOVAL_MIN_ITEMS");
  }
  return n;
}

function loadAuth(env: Env): AuthConfig {
  const mode = env.FEED_AUTH_MODE ?? "basic";
  if (mode === "basic") {
    const path = env.FEED_PATH ?? "/";
    if (!path.startsWith("/")) throw new ConfigError("FEED_PATH");
    const user = env.FEED_BASIC_AUTH_USER;
    const pass = env.FEED_BASIC_AUTH_PASS;
    // RFC 7617: the user id cannot contain a colon.
    if (!user || user.includes(":")) throw new ConfigError("FEED_BASIC_AUTH_USER");
    if (!pass || pass.length < MIN_PASSWORD_LENGTH) throw new ConfigError("FEED_BASIC_AUTH_PASS");
    return { mode, path, user, pass };
  }
  if (mode === "path") {
    const secret = env.FEED_PATH_SECRET;
    if (!secret || secret.length < MIN_PATH_SECRET_LENGTH || !PATH_SECRET_PATTERN.test(secret)) {
      throw new ConfigError("FEED_PATH_SECRET");
    }
    return { mode, secret };
  }
  throw new ConfigError("FEED_AUTH_MODE");
}

function loadMaxBodyBytes(raw: string | number | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MAX_BODY_BYTES;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BODY_BYTES_CEILING) {
    throw new ConfigError("MAX_BODY_BYTES");
  }
  return n;
}

/** Whether the public jobs fallback is switched on. Anything but "on" is off. */
export function fallbackEnabled(env: Env): boolean {
  return env.JOBS_FALLBACK === "on";
}

export interface FallbackConfig {
  siteOrigin: string;
  store: Config["store"];
}

/**
 * The jobs fallback's settings. Read only on the fallback path and never
 * needs the feed's secrets, so a mistake here answers 503 there and cannot
 * stop the feed.
 */
export function loadFallback(env: Env): FallbackConfig {
  return { siteOrigin: loadSiteOrigin(env.SITE_ORIGIN), store: loadStore(env) };
}

// An https origin only: scheme, host and optional port, no path or trailing slash.
function loadSiteOrigin(raw: string | undefined): string {
  let origin: string | undefined;
  try {
    const url = new URL(raw ?? "");
    origin = url.protocol === "https:" ? url.origin : undefined;
  } catch {
    origin = undefined;
  }
  if (!origin || origin !== raw) throw new ConfigError("SITE_ORIGIN");
  return origin;
}

export function loadStore(env: Env): Config["store"] {
  const kind = env.CAPTURE_STORE ?? "kv";
  if (kind !== "kv" && kind !== "r2") throw new ConfigError("CAPTURE_STORE");
  const name = env.CAPTURE_BINDING ?? "FEED_CAPTURE";
  // Own properties only, and it must look like a KV or R2 binding: a name such
  // as "__proto__" would otherwise pass and fail every write as a 500.
  const binding = Object.hasOwn(env, name) ? env[name] : undefined;
  if (!binding || typeof binding !== "object" || typeof (binding as { put?: unknown }).put !== "function") {
    throw new ConfigError("CAPTURE_BINDING");
  }
  return { kind, binding };
}
