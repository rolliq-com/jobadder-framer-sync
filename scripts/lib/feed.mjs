// Feed helpers for setup and capture: removing EmailTo elements, the synthetic
// smoke-test feed, and credential generation. Pure functions with no Node APIs
// (Web Crypto only), so the tests run them in the Worker test runtime.

import { XMLValidator } from "fast-xml-parser";

/**
 * @typedef {{ kind: "text" | "other", start: number, end: number }
 *   | { kind: "open" | "close" | "empty", start: number, end: number, local: string }} Token
 */

/**
 * Splits XML into tags and the text between them. Comments, CDATA, processing
 * instructions and declarations are "other" and never looked inside, so an
 * "<EmailTo>" written inside a job description's CDATA is left alone.
 * @param {string} xml
 * @returns {Token[]}
 */
function tokenize(xml) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", start: i, end: xml.length });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", start: i, end: lt });
    /** @param {string} close */
    const through = (close) => {
      const at = xml.indexOf(close, lt + 1);
      if (at === -1) throw new Error("The capture is not well-formed XML.");
      return at + close.length;
    };
    let end;
    if (xml.startsWith("<!--", lt)) end = through("-->");
    else if (xml.startsWith("<![CDATA[", lt)) end = through("]]>");
    else if (xml.startsWith("<?", lt)) end = through("?>");
    else if (xml.startsWith("<!", lt)) end = through(">");
    if (end !== undefined) {
      tokens.push({ kind: "other", start: lt, end });
      i = end;
      continue;
    }
    // An element tag: find its ">" outside quoted attribute values.
    let j = lt + 1;
    let quote = "";
    for (; j < xml.length; j++) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= xml.length) throw new Error("The capture is not well-formed XML.");
    end = j + 1;
    const closing = xml[lt + 1] === "/";
    const name = /^[^\s/>]+/.exec(xml.slice(lt + (closing ? 2 : 1), end))?.[0] ?? "";
    const local = name.slice(name.indexOf(":") + 1);
    const kind = closing ? "close" : xml[end - 2] === "/" ? "empty" : "open";
    tokens.push({ kind, start: lt, end, local });
    i = end;
  }
  return tokens;
}

/**
 * Removes every EmailTo element (the applications address inside Apply, which
 * may name a person) and returns the rest of the feed byte for byte. EmailTo is
 * removed wherever it appears, not only under Apply. Fails closed: if the result
 * is not well-formed or still contains an EmailTo element, it throws.
 * @param {string} xml
 */
export function stripEmailTo(xml) {
  const tokens = tokenize(xml);
  let out = "";
  let removed = 0;
  let jobs = 0;
  for (let t = 0; t < tokens.length; t++) {
    const token = /** @type {Token} */ (tokens[t]);
    if ((token.kind === "open" || token.kind === "empty") && token.local === "Job") jobs++;
    if ((token.kind !== "open" && token.kind !== "empty") || token.local !== "EmailTo") {
      out += xml.slice(token.start, token.end);
      continue;
    }
    // Skip to the matching close tag, then drop the indentation left before it.
    if (token.kind === "open") {
      let depth = 1;
      while (depth > 0) {
        const next = tokens[++t];
        if (!next) throw new Error("The capture is not well-formed XML.");
        if (next.kind === "open") depth++;
        else if (next.kind === "close") depth--;
      }
    }
    const next = tokens[t + 1];
    if (/\n[ \t]*$/.test(out) && next?.kind === "text" && /^[ \t]*\r?\n/.test(xml.slice(next.start, next.end))) {
      out = out.replace(/[ \t]*$/, "");
      tokens[t + 1] = { kind: "text", start: next.start + (/^[ \t]*\r?\n/.exec(xml.slice(next.start, next.end))?.[0].length ?? 0), end: next.end };
    }
    removed++;
  }

  if (XMLValidator.validate(out) !== true) throw new Error("Removing EmailTo left the file malformed, so nothing was written.");
  if (tokenize(out).some((t) => "local" in t && t.local === "EmailTo")) {
    throw new Error("An EmailTo element is still present, so nothing was written.");
  }
  return { xml: out, removed, jobs, otherEmails: countEmails(out) };
}

/**
 * Email addresses left anywhere in the text (for example in a description).
 * The caller warns; it does not remove them.
 * @param {string} text
 */
export function countEmails(text) {
  return (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []).length;
}

const SMOKE_MARKER = 'advertiser="setup-smoke-test"';

/**
 * A synthetic feed the size of a real one (about 40 ads), posted by setup's
 * first smoke test. Real-sized on purpose: on the Workers Free plan its CPU
 * time can exceed the limit, which shows up during setup instead of on
 * JobAdder's first push.
 */
export function smokeFeed(count = 40) {
  const jobs = Array.from({ length: count }, (_, n) => {
    const jid = 9000000 + n;
    return `  <Job jid="${jid}" reference="SMOKE-${n}" datePosted="2026-01-01" dateUpdated="2026-01-01T00:00:00">
    <Title>Setup test ad ${n}</Title>
    <Summary>Synthetic ad posted by npm run setup. Overwritten by JobAdder's first push.</Summary>
    <Description><![CDATA[<p>${"Synthetic text. ".repeat(40)}</p>]]></Description>
    <Classifications>
      <Classification name="Category">Test</Classification>
      <Classification name="Location">Test</Classification>
    </Classifications>
    <Apply><Url>https://example.invalid/${jid}</Url></Apply>
  </Job>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<Jobs ${SMOKE_MARKER}>\n${jobs.join("\n")}\n</Jobs>\n`;
}

/**
 * True for the payload setup posts, or the bare test body the manual steps use.
 * @param {string} xml
 */
export function isSmokePayload(xml) {
  return xml.includes(SMOKE_MARKER) || xml.trim() === "<Jobs/>";
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Uniformly random characters (rejection sampling, no modulo bias).
 * @param {number} length
 * @param {string} alphabet
 */
export function randomString(length, alphabet = ALPHANUMERIC) {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** Letters and digits only, so it survives copy and paste into any web form. */
export function generatePassword() {
  return randomString(32);
}

export function generateUsername() {
  return `jobadder-${randomString(8, "abcdefghijkmnpqrstuvwxyz23456789")}`;
}

/**
 * Builds the HTTP basic-auth header value.
 * @param {string} user
 * @param {string} pass
 */
export function basicAuthHeader(user, pass) {
  return "Basic " + btoa(`${user}:${pass}`);
}

/**
 * Plain-language reading of a smoke-test response.
 * @param {"login" | "probe" | "wrong-login"} check
 * @param {number} status
 * @param {string} body
 * @returns {{ ok: boolean, retry: boolean, message: string }}
 */
export function interpretSmoke(check, status, body) {
  const expected = check === "login" ? 200 : check === "probe" ? 400 : 401;
  if (status === expected) {
    const message =
      check === "login" ? "the right login is accepted and a test feed was stored"
      : check === "probe" ? "the right login is accepted (nothing was stored, your existing capture is untouched)"
      : "a wrong login is refused";
    return { ok: true, retry: false, message };
  }
  if (body.includes("1102") || /exceeded.*cpu/i.test(body)) {
    return { ok: false, retry: false, message: "Cloudflare stopped the Worker for using too much CPU (error 1102). The account needs the Workers Paid plan: Cloudflare dashboard > Workers & Pages > Plans." };
  }
  if (status === 503 && body.trim() === "service unavailable") {
    return { ok: false, retry: true, message: "the Worker reports a missing or invalid setting (usually the secrets are still being applied)" };
  }
  if (status === 401 && check !== "wrong-login") {
    return { ok: false, retry: true, message: "the login was refused (new secrets can take a few seconds to apply)" };
  }
  if ([404, 522, 523, 525, 526, 530].includes(status)) {
    return { ok: false, retry: true, message: `Cloudflare answered ${status} (the new hostname is usually still being set up)` };
  }
  return { ok: false, retry: false, message: `unexpected answer ${status}` };
}

/**
 * Text from the live Worker, made safe to print: no control characters (so no
 * terminal escape sequences) and a bounded length.
 * @param {unknown} value
 */
function shown(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 80);
}

/** @param {unknown} value */
function settingText(value) {
  if (value === "ok") return "ok";
  const name = value && typeof value === "object" ? /** @type {{ invalid?: unknown }} */ (value).invalid : undefined;
  return `INVALID: ${shown(name ?? "unknown")}`;
}

/**
 * Plain-language reading of the live Worker's GET /status, for setup.
 * "fail" means the feed is not working as set (a setting is invalid); "warn"
 * means it works but something needs a look.
 * @param {number} status
 * @param {string} body
 * @param {string} localVersion the version in this folder's package.json
 * @returns {{ verdict: "pass" | "warn" | "fail", lines: string[] }}
 */
export function formatStatus(status, body, localVersion) {
  if (status === 404) {
    return {
      verdict: "warn",
      lines: [`The live Worker has no status page: it runs a release older than v0.1.4. This folder is v${shown(localVersion)}; run npm run setup to deploy it.`],
    };
  }
  /** @type {any} */
  let s;
  try {
    s = status === 200 ? JSON.parse(body) : undefined;
  } catch {
    s = undefined;
  }
  if (!s || typeof s !== "object" || s.service !== "jobadder-feed-worker") {
    return { verdict: "warn", lines: [`Could not read the status page (HTTP ${status}).`] };
  }

  /** @type {"pass" | "warn" | "fail"} */
  let verdict = "pass";
  const lines = [];
  const deployed = s.deployment ? ` (Cloudflare version ${shown(s.deployment.id)}, uploaded ${shown(s.deployment.at || "unknown")})` : "";
  lines.push(`Release:        v${shown(s.version)}${deployed}`);
  if (s.version !== localVersion) {
    verdict = "warn";
    lines.push(`  WARN  this folder is v${shown(localVersion)}, the live Worker is v${shown(s.version)}. To deploy this folder: npm run setup`);
  }
  lines.push(`Mode:           ${shown(s.feed_mode)}`);
  lines.push(`Settings:       ${settingText(s.config)}`);
  if (s.config !== "ok" || s.feed_mode === "invalid") {
    verdict = "fail";
    lines.push("  FAIL  every push is refused with 503 until this setting is fixed (docs/DEPLOY.md, Secrets and Sync mode).");
  }
  lines.push(`Jobs fallback:  ${s.jobs_fallback === "off" ? "off" : settingText(s.jobs_fallback)}`);
  if (s.jobs_fallback !== "off" && s.jobs_fallback !== "ok") {
    verdict = "fail";
    lines.push("  FAIL  GET /jobs.json answers 503 until this is fixed; the feed itself is unaffected (docs/DEPLOY.md, Switching on the jobs fallback).");
  }
  if (s.mass_removal_override) {
    lines.push("Override:       ALLOW_MASS_REMOVAL_SHA is set. Remove it once the push it names has synced.");
  }

  if (s.records !== "ok") {
    lines.push(`Last push/sync: not readable (${s.records === "unset" ? "no valid storage binding" : "storage error, try again shortly"})`);
    if (verdict === "pass") verdict = "warn";
    return { verdict, lines };
  }
  const push = s.last_push;
  lines.push(`Last push:      ${push ? `${shown(push.at)} (payload ${shown(push.sha256)})` : "none yet"}`);
  const sync = s.last_sync;
  if (!sync) {
    lines.push(`Last sync:      ${s.feed_mode === "sync" ? "none yet (the cron syncs the stored push within 30 minutes)" : "none (capture mode)"}`);
  } else {
    const counts = [
      sync.jobs !== undefined ? `${shown(sync.jobs)} jobs` : "",
      sync.upserted !== undefined ? `${shown(sync.upserted)} written` : "",
      sync.removed !== undefined ? `${shown(sync.removed)} removed` : "",
      sync.held_removals ? `${shown(sync.held_removals)} removals held` : "",
      sync.published === undefined ? "" : sync.published ? "published" : "not published",
      `${shown(sync.ms)} ms`,
    ].filter(Boolean);
    const reason = sync.reason ? ` (${shown(sync.reason)})` : "";
    lines.push(`Last sync:      ${shown(sync.outcome)}${reason} by ${shown(sync.trigger)} at ${shown(sync.at)}: ${counts.join(", ")}`);
    if (sync.outcome === "held") {
      lines.push(`  WARN  removals are held. If they are genuine, set ALLOW_MASS_REMOVAL_SHA to ${shown(sync.sha256)} (docs/DEPLOY.md, The launch push).`);
      if (verdict === "pass") verdict = "warn";
    } else if (sync.outcome === "refused") {
      lines.push("  WARN  the last push was refused and nothing on the site changed; the next good push syncs (docs/DEPLOY.md, Reading the sync logs).");
      if (verdict === "pass") verdict = "warn";
    } else if (sync.outcome !== "ok") {
      lines.push("  WARN  the last sync did not finish; the cron retries every 30 minutes (docs/DEPLOY.md, Reading the sync logs).");
      if (verdict === "pass") verdict = "warn";
    }
  }
  return { verdict, lines };
}
