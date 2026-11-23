// HTTPS POST for setup's live checks, resolving the hostname through
// Cloudflare's DNS-over-HTTPS instead of the computer's resolver.
//
// Why: setup checks a brand new hostname seconds after Cloudflare creates its
// DNS record. The first lookup can run before the record exists, and the local
// resolver then caches "no such name" for the zone's negative TTL (30 minutes
// on Cloudflare zones), so every retry fails long after the record is live.
// DNS-over-HTTPS has no such cache on this computer. The TLS certificate is
// still checked against the hostname, so this weakens nothing.

import { lookup as systemLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";

const DOH = "https://cloudflare-dns.com/dns-query";

/**
 * @param {string} hostname
 * @returns {Promise<string[]>} IPv4 addresses, empty if the name does not exist yet
 */
async function dohLookup(hostname) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DNS-over-HTTPS answered ${res.status}`);
  const data = /** @type {{ Answer?: { type: number, data: string }[] }} */ (await res.json());
  return (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
}

/**
 * Node's lookup hook. Falls back to the system resolver if DNS-over-HTTPS is
 * unreachable (for example blocked on a corporate network).
 * @type {import("node:net").LookupFunction}
 */
const lookup = (hostname, options, callback) => {
  const cb = /** @type {any} */ (callback);
  dohLookup(hostname).then(
    (addresses) => {
      if (addresses.length === 0) {
        cb(Object.assign(new Error(`${hostname} has no DNS record yet`), { code: "ENOTFOUND" }));
      } else if (options.all) {
        cb(null, addresses.map((address) => ({ address, family: 4 })));
      } else {
        cb(null, addresses[0], 4);
      }
    },
    () => systemLookup(hostname, options, cb),
  );
};

/**
 * POSTs a small body and returns the status and response text. Never follows
 * redirects.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} body
 * @returns {Promise<{ status: number, body: string }>}
 */
export function post(url, headers, body) {
  return send("POST", url, headers, body);
}

/**
 * GETs a URL and returns the status and response text. Never follows
 * redirects.
 * @param {string} url
 * @returns {Promise<{ status: number, body: string }>}
 */
export function get(url) {
  return send("GET", url, { Accept: "application/json" }, "");
}

/**
 * @param {"GET" | "POST"} method
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} body
 * @returns {Promise<{ status: number, body: string }>}
 */
function send(method, url, headers, body) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method,
        headers: method === "POST" ? { ...headers, "Content-Length": String(Buffer.byteLength(body)) } : headers,
        // An IP literal (local rehearsal) needs no lookup.
        ...(isIP(target.hostname) ? {} : { lookup }),
        timeout: 20_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (text.length < 10_000) text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (method === "POST") req.end(body);
    else req.end();
  });
}
