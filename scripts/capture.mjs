// npm run capture: saves the latest feed JobAdder pushed, with every EmailTo
// element (the applications address, which may name a person) already
// removed, ready to share with whoever builds the site. The unedited feed is never written to disk.
//
// Rehearsal only: --local reads the local development storage instead.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkNodeAndInstall, fail, parseArgs, ROOT, say, wrangler } from "./lib/cli.mjs";
import { readSettings } from "./lib/config-edit.mjs";
import { isSmokePayload, stripEmailTo } from "./lib/feed.mjs";

const CAPTURE_KEY = "latest.xml";

const args = parseArgs(process.argv.slice(2));
checkNodeAndInstall();
const settings = readSettings(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
const where = args.local ? "--local" : "--remote";
if (!args.local && !settings.accountId) fail("the Worker has not been set up yet. Run npm run setup first.");
if (settings.store === "r2" && !settings.r2Bucket) fail("CAPTURE_STORE is r2 but no r2_buckets entry is set in wrangler.jsonc.");
const opts = { accountId: settings.accountId || undefined };

say("Fetching the latest capture from Cloudflare...");
const res =
  settings.store === "r2"
    ? wrangler(["r2", "object", "get", `${settings.r2Bucket}/${CAPTURE_KEY}`, where, "--pipe"], opts)
    : wrangler(["kv", "key", "get", CAPTURE_KEY, "--binding", settings.binding, where, "--text"], opts);
// "kv key get --text" ends its output with one newline of its own.
const raw = settings.store === "r2" ? res.stdout : res.stdout.replace(/\n$/, "");
if (!res.ok) fail(`could not read the capture.\n${res.stderr}`);
if (raw.trim() === "" || /^value not found/i.test(raw.trim())) {
  fail("nothing has been captured yet. JobAdder pushes within about 15 minutes of an ad change: change an ad on the board, wait, and try again.");
}
if (isSmokePayload(raw)) {
  fail("the stored feed is still the test feed from npm run setup, so JobAdder has not pushed yet. Change an ad on the board, wait about 15 minutes, and try again.");
}

let result;
try {
  result = stripEmailTo(raw);
} catch (err) {
  fail(`${/** @type {Error} */ (err).message} Check the "outcome" lines in the Worker log instead.`);
}

const file = `feed-capture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.xml`;
writeFileSync(join(ROOT, file), result.xml);
say(`
Saved: ${file}
  Ads in the feed:          ${result.jobs}
  EmailTo elements removed: ${result.removed}`);
if (result.otherEmails > 0) {
  say(`
Note: ${result.otherEmails} other email address(es) remain in the text, for example in an ad's
description. Ads are public, so this is usually fine; check them before sending if unsure.`);
}
say(`
Keep this file, or share it with whoever builds the site's job pages. Nothing else needs editing.`);
