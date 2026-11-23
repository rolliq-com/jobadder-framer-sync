// npm run setup: deploys the feed Worker to a Cloudflare account in one guided
// pass. Safe to run again: it reuses what already exists and changes only what
// is missing. The generated password is shown once on screen and is never
// written to a file. A redeploy keeps the live Worker's variables (for example
// FEED_MODE and the sync settings set in the dashboard): it reads them first,
// shows them, and stops without deploying if it cannot.
//
//   npm run setup                     first deploy, or re-check and redeploy
//   npm run setup -- --rotate         replace the login, then show the new one
//   npm run setup -- --check          only test the live endpoint, and show
//                                     its status page (GET /status)
//
// Options: --board=<JobAdder board number> fills it into the email to JobAdder.
// For unattended use: --account-id=<id> --hostname=<name>
// Rehearsal only: --check --url=<https url>, with FEED_BASIC_AUTH_USER and
// FEED_BASIC_AUTH_PASS in the environment.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, checkNodeAndInstall, confirm, fail, parseArgs, parseJson, ROOT, say, step, wrangler } from "./lib/cli.mjs";
import { applySettings, normalizeHostname, readSettings } from "./lib/config-edit.mjs";
import { activeVersionId, fileVars, isNothingLive, liveVars, MASS_REMOVAL_SHA, planVars, varArgs } from "./lib/live-vars.mjs";
import { checkBoard, jobadderEmail } from "./lib/email.mjs";
import { basicAuthHeader, formatStatus, generatePassword, generateUsername, interpretSmoke, isSmokePayload, smokeFeed } from "./lib/feed.mjs";
import { get, post } from "./lib/http.mjs";

const CONFIG = join(ROOT, "wrangler.jsonc");
const KV_TITLE = "jobadder-feed-capture";
const CAPTURE_KEY = "latest.xml";
const SECRET_NAMES = ["FEED_BASIC_AUTH_USER", "FEED_BASIC_AUTH_PASS"];
// The release in this folder, compared with the one the live Worker reports.
const LOCAL_VERSION = String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
// A new custom domain usually answers within a few minutes (DNS record, then
// certificate).
const SMOKE_WAIT_MS = 10 * 60_000;
/** @type {number | undefined} */
let smokeDeadline;

const args = parseArgs(process.argv.slice(2));
checkNodeAndInstall();
// Checked up front, not after the deploy.
if (args.board === true) fail("--board needs the board number, for example --board=12345");
if (args.board !== undefined) {
  try {
    checkBoard(String(args.board));
  } catch (err) {
    fail(/** @type {Error} */ (err).message);
  }
}
let text = readFileSync(CONFIG, "utf8");
let settings = readSettings(text);
if (settings.authMode !== "basic") {
  fail(`wrangler.jsonc uses FEED_AUTH_MODE "${settings.authMode}". This script sets up the default basic-auth mode only; follow "Fallback: unguessable path" in docs/DEPLOY.md.`);
}

if (args.check) {
  await checkOnly();
  process.exit(0);
}

// 1. Cloudflare login and account
step("1/8 Cloudflare login");
let who = wrangler(["whoami", "--json"]);
if (!who.ok) {
  say("You are not logged in to Cloudflare from this computer yet.");
  say("A browser window will open: log in to Cloudflare as usual and click Allow, then come back here.");
  if (!wrangler(["login"], { inherit: true }).ok) fail("the Cloudflare login did not complete. Run npm run setup again to retry.");
  who = wrangler(["whoami", "--json"]);
  if (!who.ok) fail("still not logged in to Cloudflare after the login step.");
}
const user = parseJson(who.stdout);
/** @type {{ id: string, name: string }[]} */
const accounts = user.accounts ?? [];
say(`Logged in as ${user.email ?? "an API token"}.`);

step("2/8 Cloudflare account");
const accountId = await chooseAccount();
const accountName = accounts.find((a) => a.id === accountId)?.name ?? accountId;
say(`Using account: ${accountName}`);

// 2. Hostname
step("3/8 Web address for the feed");
const hostname = await chooseHostname();
say(`The feed will be served at https://${hostname}${settings.feedPath}`);

// 3. Storage
step("4/8 Storage for the captured feed");
const kvId = settings.store === "kv" ? ensureKvNamespace() : undefined;
if (settings.store !== "kv") say(`Using the R2 bucket set in wrangler.jsonc (${settings.r2Bucket || "not set"}).`);

const updated = applySettings(text, { accountId, hostname, kvId });
if (updated !== text) {
  writeFileSync(CONFIG, updated);
  text = updated;
  settings = readSettings(text);
  say("Saved the account, web address and storage ID in wrangler.jsonc.");
} else {
  say("wrangler.jsonc already has these settings.");
}

// 4. The live Worker's settings. Read before anything is written to the
// account, so a first install is told apart from a failed read. A deploy sets
// the variables to exactly what it is given, so every live variable is passed
// back in; if they cannot be read, nothing is deployed.
step("5/8 Settings on the live Worker");
const deployVars = await keepLiveVars();

// 5. Login for JobAdder. Secrets go in BEFORE the code is deployed: if the
// Worker does not exist yet, wrangler creates an empty placeholder with no web
// address, so the real Worker never runs without a login.
step("6/8 Login for JobAdder");
const existing = secretNames();
let login;
if (args.rotate || !SECRET_NAMES.every((n) => existing.includes(n))) {
  if (args.rotate) say("Replacing the username and password (--rotate).");
  login = { user: generateUsername(), pass: generatePassword() };
  const input = JSON.stringify({ FEED_BASIC_AUTH_USER: login.user, FEED_BASIC_AUTH_PASS: login.pass });
  const put = wrangler(["secret", "bulk"], { input, accountId });
  if (!put.ok) fail(`could not save the login as Worker secrets.\n${put.stderr || put.stdout}`);
  // Shown now, before the deploy and checks, so a failure later in the run
  // cannot leave a login nobody has seen.
  say(`Generated a new login and saved it as encrypted Worker secrets:

  Username:   ${login.user}
  Password:   ${login.pass}

This password is shown only now and is not saved anywhere on this computer.
Store it in your password manager NOW, before setup continues. If it is ever lost, run:
npm run setup -- --rotate`);
  if (process.stdin.isTTY) await ask("Press Enter once it is stored. ");
} else {
  say("A login is already set and is kept. (To replace it: npm run setup -- --rotate)");
}

// 6. Deploy
step("7/8 Deploy");
say("Uploading the Worker. The first time, Cloudflare also creates the DNS record and certificate.");
if (!wrangler(["deploy", ...deployVars], { inherit: true, accountId }).ok) {
  fail(`the deploy did not complete. Common causes:
  - The domain in ${hostname} is not a zone on the "${accountName}" account. Use a subdomain of a domain that is on this account.
  - ${hostname} already has a DNS record. Choose another name, or delete that record first.
  - Your Cloudflare user lacks permission. It needs to edit Workers, Workers KV and the domain's DNS (Administrator or Super Administrator works).
Fix the cause and run npm run setup again; it picks up where it stopped.`);
}

// 7. Smoke tests
step("8/8 Check the live endpoint");
const url = `https://${hostname}${settings.feedPath}`;
let testLogin = login;
if (!testLogin && !process.stdin.isTTY) {
  say("Not an interactive terminal, so the existing login is not tested here. Test it with: npm run setup -- --check");
} else if (!testLogin) {
  say("To test the existing login, enter it now (or press Enter to skip that test).");
  const u = await ask("Username: ");
  testLogin = u ? { user: u, pass: await ask("Password (hidden): ", { hidden: true }) } : undefined;
}
let passed = true;
if (testLogin) {
  // Never overwrite a real capture with test data: if JobAdder has already
  // pushed, prove the login with a request that is refused after the login
  // check and stores nothing.
  const destructiveOk = settings.store === "kv" && !hasRealCapture();
  passed = await smoke(url, destructiveOk ? "login" : "probe", testLogin) && passed;
}
passed = await smoke(url, "wrong-login", { user: "wrong", pass: "wrong" }) && passed;
if (!passed) fail("the endpoint did not pass its checks (see above). Nothing needs undoing: fix the cause and run npm run setup again.");
say("\nLive status (https://" + hostname + "/status):");
if ((await showStatus(`https://${hostname}`)) === "fail") {
  fail("the live Worker reports an invalid setting (see above). Fix it in wrangler.jsonc or the secrets and run npm run setup again.");
}

const email = jobadderEmail({
  url,
  username: login?.user ?? testLogin?.user,
  board: typeof args.board === "string" ? args.board : undefined,
  rotated: Boolean(args.rotate),
});
say(login
  ? `\nSetup complete. The login is the one shown in step 6/8 (username ${login.user}).`
  : "\nSetup complete. The existing login is unchanged: if JobAdder already has it, there is nothing more to send.");
say(`
Next, send this email. It does NOT contain the password: once a JobAdder agent replies,
send the password to that agent separately (a share from the site owner's password manager, or by phone).

----- email to JobAdder support (password: send separately, not in this email) -----
${email}
----- end of email -----

When JobAdder confirms it is enabled, ask the client's account owner to post or edit an ad
on the board. JobAdder pushes within about 15 minutes of that change. Then run: npm run capture`);

/**
 * Reads the live Worker's plain-text variables and returns the deploy
 * arguments that set them again. Stops setup on anything it cannot read.
 * @returns {Promise<string[]>}
 */
async function keepLiveVars() {
  const name = settings.name;
  /** @type {Record<string, string>} */
  let fromFile = {};
  try {
    fromFile = fileVars(text);
  } catch (err) {
    fail(/** @type {Error} */ (err).message);
  }
  const unreadable = "could not read the live Worker's current settings, so nothing was deployed (a deploy would reset them to wrangler.jsonc).";
  const status = wrangler(["deployments", "status", "--name", name, "--json"], { accountId });
  if (!status.ok) {
    if (isNothingLive(`${status.stderr}\n${status.stdout}`)) {
      say(`No Worker named "${name}" is live on this account yet, so the settings in wrangler.jsonc are used.`);
      return [];
    }
    fail(`${unreadable}\n${status.stderr || status.stdout}\nCheck that this login can read Workers on the account, then run npm run setup again.`);
  }
  /** @type {Record<string, string>} */
  let live = {};
  try {
    const versionId = activeVersionId(parseJson(status.stdout));
    const view = wrangler(["versions", "view", versionId, "--name", name, "--json"], { accountId });
    if (!view.ok) throw new Error(view.stderr || view.stdout);
    live = liveVars(parseJson(view.stdout));
  } catch (err) {
    fail(`${unreadable}\n${/** @type {Error} */ (err).message}`);
  }
  let keepSha = false;
  if (live[MASS_REMOVAL_SHA] !== undefined) {
    say(`The live Worker still has ${MASS_REMOVAL_SHA} = ${JSON.stringify(live[MASS_REMOVAL_SHA])}.`);
    say("It lets one held push remove more jobs than the safety limit, and should be removed once that push has synced.");
    keepSha = await confirm(`Keep ${MASS_REMOVAL_SHA}? (No removes it)`, false);
    if (!keepSha && fromFile[MASS_REMOVAL_SHA] !== undefined) {
      fail(`wrangler.jsonc also sets ${MASS_REMOVAL_SHA}, so the deploy would set it again. Remove that line from wrangler.jsonc and run npm run setup again.`);
    }
  }
  const { carry, lines } = planVars(fromFile, live, keepSha);
  say("The deploy keeps the live Worker's variables (keep), adds any it does not have yet from");
  say("wrangler.jsonc (new), and leaves the secrets as they are:");
  for (const line of lines) say(line);
  try {
    return varArgs(carry);
  } catch (err) {
    return fail(/** @type {Error} */ (err).message);
  }
}

async function chooseAccount() {
  const fromArg = typeof args["account-id"] === "string" ? args["account-id"] : "";
  if (fromArg) return fromArg;
  if (settings.accountId && (accounts.length === 0 || accounts.some((a) => a.id === settings.accountId))) {
    return settings.accountId;
  }
  if (accounts.length === 0) fail("this Cloudflare login has access to no accounts.");
  if (accounts.length === 1) {
    const only = /** @type {{ id: string, name: string }} */ (accounts[0]);
    if (await confirm(`Deploy to the account "${only.name}"?`)) return only.id;
    fail('run "npx wrangler logout", then npm run setup again and log in as the user for the right account.');
  }
  say("This login can use several Cloudflare accounts. Pick the client's account:");
  accounts.forEach((a, n) => say(`  ${n + 1}. ${a.name}`));
  for (;;) {
    const pick = accounts[Number(await ask(`Account number (1-${accounts.length}): `)) - 1];
    if (pick) return pick.id;
  }
}

async function chooseHostname() {
  if (typeof args.hostname === "string") return normalizeHostname(args.hostname);
  if (settings.hostname) return settings.hostname;
  say("Choose the web address JobAdder will send the feed to: a new subdomain of a domain");
  say("that is already on this Cloudflare account, for example jobs-feed.example.com.");
  say("Cloudflare creates the DNS record and certificate itself; the name must not exist yet.");
  for (;;) {
    try {
      return normalizeHostname(await ask("Web address: "));
    } catch (err) {
      say(String(/** @type {Error} */ (err).message));
    }
  }
}

function ensureKvNamespace() {
  const list = wrangler(["kv", "namespace", "list"], { accountId });
  if (!list.ok) fail(`could not list KV namespaces.\n${list.stderr}`);
  /** @type {{ id: string, title: string }[]} */
  const namespaces = parseJson(list.stdout);
  const current = namespaces.find((ns) => ns.id === settings.kvId) ?? namespaces.find((ns) => ns.title === KV_TITLE);
  if (current) {
    say(`Reusing the existing KV namespace "${current.title}".`);
    return current.id;
  }
  const created = wrangler(["kv", "namespace", "create", KV_TITLE, "--update-config=false"], { accountId });
  if (!created.ok) fail(`could not create the KV namespace.\n${created.stderr}`);
  const again = /** @type {{ id: string, title: string }[]} */ (parseJson(wrangler(["kv", "namespace", "list"], { accountId }).stdout));
  const made = again.find((ns) => ns.title === KV_TITLE);
  if (!made) fail("created the KV namespace but could not find it afterwards. Run npm run setup again.");
  say(`Created the KV namespace "${KV_TITLE}".`);
  return made.id;
}

/** @returns {string[]} */
function secretNames() {
  const res = wrangler(["secret", "list", "--format", "json"], { accountId });
  // A Worker that does not exist yet has no secrets.
  if (!res.ok) return [];
  return parseJson(res.stdout).map((/** @type {{ name: string }} */ s) => s.name);
}

function hasRealCapture() {
  const res = wrangler(["kv", "key", "get", CAPTURE_KEY, "--binding", settings.binding, "--remote", "--text"], { accountId });
  return res.ok && res.stdout.trim() !== "" && !isSmokePayload(res.stdout);
}

/**
 * @param {string} target
 * @param {"login" | "probe" | "wrong-login"} check
 * @param {{ user: string, pass: string }} creds
 */
async function smoke(target, check, creds) {
  const label = { login: "Right login", probe: "Right login", "wrong-login": "Wrong login" }[check];
  // One wait shared by all checks: the second check does not start a new one.
  smokeDeadline ??= Date.now() + SMOKE_WAIT_MS;
  const deadline = smokeDeadline;
  let waited = false;
  for (;;) {
    let status = 0;
    let body = "";
    let reason;
    try {
      const res = await post(
        target,
        { Authorization: basicAuthHeader(creds.user, creds.pass), "Content-Type": "application/xml" },
        // The probe body is not XML, so the Worker refuses it after the login
        // check and stores nothing.
        check === "login" ? smokeFeed() : check === "probe" ? "setup-probe" : "<Jobs/>",
      );
      status = res.status;
      body = res.body;
    } catch (err) {
      const code = /** @type {any} */ (err).code ?? /** @type {Error} */ (err).message;
      reason = code === "ENOTFOUND"
        ? "the new web address is not in DNS yet"
        : `not reachable yet (${code}; usually the certificate is still being issued)`;
    }
    const verdict = reason ? { ok: false, retry: true, message: reason } : interpretSmoke(check, status, body);
    if (verdict.ok) {
      say(`  PASS  ${label}: ${verdict.message}`);
      return true;
    }
    if (!verdict.retry || Date.now() > deadline) {
      say(`  FAIL  ${label}: ${verdict.message}`);
      return false;
    }
    if (!waited) say(`  ...   ${label}: ${verdict.message}. Retrying for up to 10 minutes.`);
    waited = true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/**
 * Prints the live Worker's GET /status. Needs no login.
 * @param {string} origin
 * @returns {Promise<"pass" | "warn" | "fail">}
 */
async function showStatus(origin) {
  let res;
  try {
    res = await get(`${origin}/status`);
  } catch (err) {
    const code = /** @type {any} */ (err).code ?? /** @type {Error} */ (err).message;
    say(`  WARN  could not reach the status page (${code})`);
    return "warn";
  }
  const { verdict, lines } = formatStatus(res.status, res.body, LOCAL_VERSION);
  for (const line of lines) say(`  ${line}`);
  return verdict;
}

async function checkOnly() {
  const target = typeof args.url === "string" ? args.url : settings.hostname ? `https://${settings.hostname}${settings.feedPath}` : "";
  if (!target) fail("no web address is set yet. Run npm run setup first.");
  let origin = "";
  try {
    origin = new URL(target).origin;
  } catch {
    fail(`"${target}" is not a full web address. Use the form --url=https://<host>/`);
  }
  say(`Live status (${origin}/status):`);
  const verdict = await showStatus(origin);
  say("");
  const envUser = process.env.FEED_BASIC_AUTH_USER;
  const envPass = process.env.FEED_BASIC_AUTH_PASS;
  const creds = envUser && envPass ? { user: envUser, pass: envPass } : { user: await ask("Username: "), pass: await ask("Password (hidden): ", { hidden: true }) };
  say(`Checking ${target}`);
  const ok = (await smoke(target, "probe", creds)) && (await smoke(target, "wrong-login", { user: "wrong", pass: "wrong" }));
  if (!ok) fail("the endpoint did not pass its checks (see above).");
  if (verdict === "fail") fail("the login checks passed, but the live Worker reports an invalid setting (see the status above).");
  say(verdict === "warn" ? "The login checks passed. Read the WARN lines in the status above." : "All checks passed.");
}
