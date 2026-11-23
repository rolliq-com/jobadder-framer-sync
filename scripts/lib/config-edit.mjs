// Reads and writes the deploy-time settings in wrangler.jsonc as targeted text
// edits, so the comments in the file survive. Pure functions: no Node APIs, so
// the tests run them in the same runtime as the Worker tests.

const PLACEHOLDER = /^<[A-Z_]+>$/;

const FIELDS = {
  name: /("name"\s*:\s*")([^"]*)(")/,
  accountId: /("account_id"\s*:\s*")([^"]*)(")/,
  hostname: /("routes"\s*:\s*\[\s*\{\s*"pattern"\s*:\s*")([^"]*)(")/,
  kvId: /("kv_namespaces"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*")([^"]*)(")/,
  store: /("CAPTURE_STORE"\s*:\s*")([^"]*)(")/,
  binding: /("CAPTURE_BINDING"\s*:\s*")([^"]*)(")/,
  authMode: /("FEED_AUTH_MODE"\s*:\s*")([^"]*)(")/,
  feedPath: /("FEED_PATH"\s*:\s*")([^"]*)(")/,
};
// Only an uncommented r2_buckets line counts.
const R2_BUCKET = /^\s*"r2_buckets"\s*:\s*\[\s*\{[^}]*?"bucket_name"\s*:\s*"([^"]*)"/m;

/**
 * The current settings. A placeholder such as <KV_NAMESPACE_ID> reads as "".
 * @param {string} text
 */
export function readSettings(text) {
  /** @param {RegExp} re */
  const get = (re) => {
    const value = re.exec(text)?.[2] ?? "";
    return PLACEHOLDER.test(value) ? "" : value;
  };
  const bucket = R2_BUCKET.exec(text)?.[1] ?? "";
  return {
    name: get(FIELDS.name),
    accountId: get(FIELDS.accountId),
    hostname: get(FIELDS.hostname),
    kvId: get(FIELDS.kvId),
    store: get(FIELDS.store) || "kv",
    binding: get(FIELDS.binding) || "FEED_CAPTURE",
    authMode: get(FIELDS.authMode) || "basic",
    feedPath: get(FIELDS.feedPath) || "/",
    r2Bucket: PLACEHOLDER.test(bucket) ? "" : bucket,
  };
}

/**
 * Writes the account, hostname and KV namespace id into the file text. Fields
 * left undefined are not touched.
 * @param {string} text
 * @param {{ accountId?: string, hostname?: string, kvId?: string }} settings
 */
export function applySettings(text, settings) {
  let out = text;
  if (settings.hostname !== undefined) out = replaceField(out, "hostname", normalizeHostname(settings.hostname));
  if (settings.kvId !== undefined) out = replaceField(out, "kvId", checkKvId(settings.kvId));
  if (settings.accountId !== undefined) {
    const id = checkAccountId(settings.accountId);
    if (FIELDS.accountId.test(out)) {
      out = replaceField(out, "accountId", id);
    } else {
      // Pin the account right after compatibility_date, so every later wrangler
      // command (deploy, secrets, capture export) targets the same account.
      const anchor = /("compatibility_date"\s*:\s*"[^"]*",)/;
      if (!anchor.test(out)) throw new Error(unrecognised("compatibility_date"));
      out = out.replace(anchor, `$1\n  "account_id": "${id}",`);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {keyof typeof FIELDS} field
 * @param {string} value
 */
function replaceField(text, field, value) {
  const re = FIELDS[field];
  if (!re.test(text)) throw new Error(unrecognised(field));
  return text.replace(re, (_m, before, _old, after) => `${before}${value}${after}`);
}

/** @param {string} field */
function unrecognised(field) {
  return `wrangler.jsonc has been edited in a way setup does not recognise (looking for ${field}). Restore it with "git checkout wrangler.jsonc" and run setup again.`;
}

/**
 * Accepts "jobs-feed.example.com", also pasted as "https://jobs-feed.example.com/".
 * @param {string} input
 */
export function normalizeHostname(input) {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => label.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) {
    throw new Error(`"${input}" is not a hostname. Enter just the name, for example jobs-feed.example.com`);
  }
  return host;
}

/** @param {string} id */
export function checkAccountId(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`"${id}" is not a Cloudflare account ID (32 hex characters).`);
  return id;
}

/** @param {string} id */
export function checkKvId(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`"${id}" is not a KV namespace ID (32 hex characters).`);
  return id;
}
