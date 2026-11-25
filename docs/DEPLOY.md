# Deploy guide

This Worker receives the job-ads XML feed that JobAdder pushes by HTTP POST. It runs in **the
site owner's own Cloudflare account** and is deployed by whoever looks after that account. Every
login, key and password belongs to the site owner. Nothing in this guide needs an account with,
or approval from, anyone else.

The Worker deploys in **capture mode**: it receives the feed, checks it and keeps a private copy
of the latest push. It forwards nothing and does not touch the website. **Sync mode** also writes
the jobs to the site's Framer CMS; switch it on separately, once the site's Jobs pages are ready
(see [Sync mode: switching sync on](#sync-mode-switching-sync-on)).

The Quick start below is the whole job. Everything after it is reference.

## Quick start

### What you need

- **A Cloudflare login for the client's account** with permission to edit Workers, Workers KV and
  the domain's DNS. The Administrator or Super Administrator role is enough.
- **The Workers Paid plan** on that account (about USD 5 per month). The Free plan stops each
  request after 10 ms of CPU time, which a real feed exceeds, so pushes would fail with Cloudflare
  error 1102. Check under Workers & Pages > Plans in the Cloudflare dashboard.
- **A domain on that account** for the feed's address, such as `jobs-feed.<client domain>`.
  You do not create any DNS record: Cloudflare does that during setup.
- **Node.js 22 or later** on the computer you deploy from (Windows, macOS or Linux). Get the LTS
  installer from <https://nodejs.org>. Check with `node --version`.
- **git**, or download the release as a ZIP instead (see below).
- **The JobAdder board number** of the board whose ads the site shows. Whoever owns the site's
  JobAdder account can find it, or ask JobAdder support.

### Steps

1. **Get the code.** The repository is public; no GitHub account is needed. Open
   <https://github.com/rolliq-com/jobadder-framer-sync>, then **Releases** > the latest release >
   **Source code (zip)**. Unzip it, open a terminal (PowerShell on Windows) and `cd` into the
   unzipped folder.

   With git, this does the same (put the latest release's tag in place of `<TAG>`):

   ```sh
   git clone --branch <TAG> https://github.com/rolliq-com/jobadder-framer-sync.git
   cd jobadder-framer-sync
   ```

2. **Install the tools** (into this folder only, nothing system-wide):

   ```sh
   npm ci
   ```

   `npm ci` may print warnings about advisories and suggest `npm audit fix --force`. **Do not run
   that**: it would change the tested tools. The advisories are in development tools, not in the
   deployed Worker (see [Dependency audit](#dependency-audit)). Carry on.

3. **Run setup**, with the board number so it can fill in the email in step 5.
   Type it exactly like this, including the `--` on its own:

   ```sh
   npm run setup -- --board=<BOARD_ID>
   ```

   It asks at most three things:
   - **Log in to Cloudflare** (first time only). A browser window opens: log in as usual and click
     **Allow**.
   - **Which account**, if your login can reach several. Pick the client's.
   - **The web address** for the feed, for example `jobs-feed.<client domain>`. It must be a new
     name on a domain that is on that account.

   It then creates the storage and generates a username and a 32-character password.

4. **Store the password when setup shows it.** Setup shows the new login **once**, part way
   through, and waits:

   ```text
   == 6/8 Login for JobAdder
   Generated a new login and saved it as encrypted Worker secrets:

     Username:   jobadder-xxxxxxxx
     Password:   (32 letters and digits)

   This password is shown only now and is not saved anywhere on this computer.
   Store it in your password manager NOW, before setup continues. ...
   Press Enter once it is stored.
   ```

   Put both in the site owner's password manager, then press Enter. Setup deploys the
   Worker and tests it. On a brand new web address the test can take a few minutes while
   Cloudflare creates the DNS record and certificate; setup waits and retries for up to 10 minutes
   on its own. Success looks like this:

   ```text
   == 8/8 Check the live endpoint
     PASS  Right login: the right login is accepted and a test feed was stored
     PASS  Wrong login: a wrong login is refused
   ```

   For up to 30 minutes after setup, your own browser may still say the new address does not
   exist. That is your computer remembering the earlier "not found" answer; it is harmless, and
   JobAdder is not affected. Setup is safe to run again at any time: it reuses what exists, and on
   a rerun its test never overwrites a capture.

5. **Ask JobAdder to set up the feed.** You do not need a JobAdder login: JobAdder support does
   this on request. Setup prints the email below with the URL, username and board filled in; copy
   it from there, or fill in this template yourself:

   ```text
   To:       support@jobadder.com
   Cc:       the client's JobAdder account owner (to authorise; they can reply "approved")
   Subject:  Please set up the XML job feed push for board <BOARD_ID>

   Hello JobAdder support,

   Please set job board <BOARD_ID> to push its XML job feed to our endpoint:

     Method:    HTTP POST, raw XML in the request body (not form-encoded)
     URL:       <URL>
     Auth:      HTTP basic auth
     Username:  <USERNAME>
     Password:  sent separately to the agent who picks this up, not in this email

   Please reply when it is enabled. The client's account owner will then post or edit an ad
   on the board so the first push goes through.

   Thank you
   ```

   - **Copy in the client's JobAdder account owner.** They own the account, and JobAdder may need
     them to authorise the change; a reply of "approved" on the thread is enough.
   - **The password is not in this email**, because the thread copies other people. When a
     JobAdder agent replies, send the password to that agent alone: a one-time share from the site owner's
     password manager, or by phone.

6. **Trigger the first push and export it.** JobAdder pushes only when an ad on the board is
   posted or edited. Once JobAdder confirms the feed is enabled, ask the client's account owner to
   post or edit a test ad. Within about 15 minutes of that change, run:

   ```sh
   npm run capture
   ```

   This saves `feed-capture-<date>.xml` in the folder with every `EmailTo` element (the
   applications address, which may name a person) already removed. Keep it, or share it with whoever builds the
   site's job pages: it shows the board's real fields. You do not need to edit it. If JobAdder has not pushed yet, capture says so: wait a few minutes
   and run it again.

That's it. Set up alerting as described in [Operating](#operating).

## Updating to a new release

When a new release appears on the repository's Releases page, read its release notes, then get it
exactly as in step 1 into a **new** folder and run, in that folder:

```sh
npm ci
npm run setup
```

Give the same account and web address as before. Setup finds the existing storage, keeps the
existing login (JobAdder needs no change) and deploys the new code. When it offers to test the
login, enter it from your password manager, or press Enter to skip. The old folder can then be
deleted.

In sync mode, no push is needed after an update: within 30 minutes the cron syncs the stored push
once with the new release, so a change in how ads are written reaches the site. Only ads whose
written content changed are rewritten, and the site is published only if something was. Then
`last_sync` in [the status page](#status-page) shows the new release.

**Coming from an earlier copy of this code** (a release numbered below v1.0.0, from another
repository): update the same way. Get the latest release from this repository into a new folder and
run `npm ci` and `npm run setup` with the same account and web address. The Worker keeps its name,
storage, login and live settings. Afterwards, `npm run setup -- --check` shows the new release
number.

**Setup keeps the live Worker's settings.** Before deploying, setup reads the variables the live
Worker has now (for example `FEED_MODE` and the sync settings from
[sync mode](#sync-mode-switching-sync-on), whether set in a file or in the dashboard) and deploys them
again, so the new folder's `wrangler.jsonc` needs no editing. It shows the list first:

```text
== 5/8 Settings on the live Worker
  keep   FEED_MODE = "sync"   (wrangler.jsonc says "capture")
  keep   JOB_COUNTRY = "NZ"
  new    SOME_NEW_SETTING = "off"   (from wrangler.jsonc)
```

`keep` is a live value deployed again, even where the file says otherwise. `new` is a variable
the live Worker does not have yet, taken from the file (a setting added in this release). Secrets
(the login, `FRAMER_API_KEY`) are never read and are not affected.

If the live Worker still has `ALLOW_MASS_REMOVAL_SHA` (see [The launch push](#the-launch-push)),
setup shows it and asks whether to keep it. The answer defaults to **No**, which removes it. Run
without a keyboard, setup stops instead of guessing.

If setup cannot read the live settings (a login without access, a network error, a deployment
split between two versions), it **stops without deploying** and says why: a deploy would reset
them. Fix the cause and run `npm run setup` again.

Only `npm run setup` does this. A bare `npx wrangler deploy` still sets the Worker's variables to
exactly what the folder's `wrangler.jsonc` says, so a dashboard edit is undone and a variable the
file lacks is removed. Wrangler's `keep_vars` option is deliberately not used: it keeps only
variables the file does not name, so `FEED_MODE` would still be reset, and it would let a
forgotten `ALLOW_MASS_REMOVAL_SHA` outlive every deploy without anyone being asked.

After the deploy, setup shows the live [status page](#status-page). Check that **Release** is the
new version, and that **Mode** and **Settings** are what you expect.

## Rotating the feed password

```sh
npm run setup -- --rotate
```

Do this whenever the password may have been seen by someone who should not have it, when a
person who held it leaves, and at least once a year. This replaces the username and password,
retests, shows the new ones once, and prints an email
asking JobAdder support to switch to the new login (the password again goes separately). Add
`--board=<BOARD_ID>` to fill in the board. Any push between the two changes is refused with 401,
and the next ad change sends it again. Store the new login in the site owner's password manager
and delete the old entry once JobAdder confirms the switch.

To retest the live endpoint at any time without changing anything:

```sh
npm run setup -- --check
```

This first shows the live [status page](#status-page) (no login needed), then tests the login.

## Operating

- **Logs and alerts:** the Worker's log lines are in the Cloudflare dashboard under Workers &
  Pages > the Worker > **Observability**. Alert on lines with `"outcome":"error"`, and on repeated
  `"reason":"bad_credentials"`. Do **not** alert on "no push for N hours": JobAdder pushes only
  when an ad changes, so days can pass without one on a healthy board.
- **Status:** `https://<FEED_HOSTNAME>/status` shows the live release, mode, settings and last
  push and sync to anyone, without a login (see [Status page](#status-page)). Anyone helping
  can check it from outside the account.
- **Rate limiting (recommended):** the Worker has no rate limit of its own. Add a Cloudflare WAF
  rate-limiting rule on the feed's hostname, for example 60 requests per minute per IP address.

## Rotating the Framer key

Sync mode only. The Framer Server API key acts as the Framer user who created it, on one project.
It stops working if that user leaves the project, loses owner or Full access, deletes the key, or
the project is transferred. If Framer shows an expiry date for the key, record it next to the key
in the site owner's password manager with a reminder a few weeks before, and replace the key
before that date.

1. The project's owner, or a Full access member who will stay, opens Site Settings > General,
   API keys in Framer and creates a new key (see [The Framer key](#the-framer-key)).
2. They pass it to whoever deploys by a password-manager share, never by email or chat, and it is
   stored in the site owner's password manager.
3. Replace the secret. No code deploy is needed:

   ```sh
   npx wrangler secret put FRAMER_API_KEY
   ```

4. Within 30 minutes `npm run setup -- --check` shows **Last sync** `ok`. Then delete the old key
   in Framer.

## Common failures

| Symptom | Likely cause | What to do |
|---|---|---|
| Every push logs `"reason":"bad_credentials"` | JobAdder has an old or mistyped login | Check the username with JobAdder support; if in doubt, [rotate the feed password](#rotating-the-feed-password) |
| Pushes log only `no_credentials` | JobAdder's sender is not sending basic auth | Use [the unguessable path](#fallback-unguessable-path-if-basic-auth-does-not-work) |
| Every request answers 503 | A setting or secret is missing or invalid | `/status` names the setting under `config`; fix it and redeploy with `npm run setup` |
| Pushes fail with Cloudflare error 1102 | The account is on the Workers Free plan | Move the account to Workers Paid |
| No push for days | Normal: JobAdder pushes only when an ad changes | Post or edit an ad on the board, then check **Last push** on `/status` |
| Every sync fails at `framer_connect` | The Framer key lost access, expired or was revoked | [Rotate the Framer key](#rotating-the-framer-key) |
| Syncs fail at `framer_write`, `framer_publish` or `framer_deploy` for days | A Framer outage, or a change to Framer's Server API | Check Framer's status page. If Framer changed its API, update `framer-api` in `package.json`, fix `src/framer.ts`, run `npm run check`, and deploy with `npm run setup` |
| A sync is held (`mass_removal_held`) | A push removed many ads at once | [The launch push](#the-launch-push) |
| `internal` on a sync | A code fault | Run `npm run check` on the release you deployed, read the log line's counts and reason, and fix in your own copy of the code |
| `/status` shows an older **Release** than expected | The deploy went from an old folder, or a bare `wrangler deploy` ran | Redeploy the release you want with `npm run setup` |

## Security review

The code has had security reviews, and every change runs CI:
typecheck, tests, a production dependency audit, Semgrep static analysis and a Gitleaks secret
scan. In short:

- The login is the only thing that identifies JobAdder. JobAdder signs nothing, so there is no
  message signature or replay protection: anyone holding the login can post, and a replayed push
  is accepted. Keep the login as secret as the account that holds it.
- The worst a valid but hostile post can do is replace the stored capture (only the latest is
  kept). In capture mode nothing is forwarded. In sync mode the post's jobs also reach the site:
  the description HTML is sanitised and the applications address (`Apply/EmailTo`) is never read.
- Unauthenticated requests are rejected before the body is read. DTDs and entity expansion are
  refused, and the body cap is enforced while streaming.
- If a secret is missing or too short, the Worker refuses every request (503) and stores nothing.

---

# Reference

Everything below is what `npm run setup` and `npm run capture` do for you, for anyone who wants
the manual route or to know exactly what changed.

## Placeholders

| Placeholder | Meaning |
|---|---|
| `<FEED_HOSTNAME>` | The HTTPS hostname the Worker serves, a subdomain of the client's domain |
| `<BOARD_ID>` | The JobAdder board that will push to this Worker |
| `<KV_NAMESPACE_ID>` | The ID of the KV namespace that holds the capture |
| `<R2_BUCKET_NAME>` | Only if R2 is used instead of KV |
| `<SITE_DOMAIN>` | Only if the jobs fallback is switched on: the website's domain |

## What setup changes

- `wrangler.jsonc`: adds `account_id`, and fills `<FEED_HOSTNAME>` and `<KV_NAMESPACE_ID>`. Nothing
  else. `git diff wrangler.jsonc` shows it; `git checkout wrangler.jsonc` undoes it.
- Cloudflare: a KV namespace named `jobadder-feed-capture`, the two Worker secrets, and the Worker
  `jobadder-feed-worker` with its custom domain (Cloudflare adds the DNS record and certificate).
- Order: the secrets are set **before** the code is deployed, so the Worker never runs without a
  login. Even if it did, it would refuse every request with 503 and store nothing.

## Secrets

Names only. Values live in two places: the Worker's encrypted secrets in Cloudflare (Workers &
Pages > the Worker > Settings > Variables and Secrets, which shows names, never values) and the
site owner's password manager. Never put a value in this repository, an email or a chat.

| Name | Used in | Purpose |
|---|---|---|
| `FEED_BASIC_AUTH_USER` | basic mode | Username JobAdder sends. No colon. |
| `FEED_BASIC_AUTH_PASS` | basic mode | Password JobAdder sends. At least 24 characters. |
| `FEED_PATH_SECRET` | path mode | Unguessable URL path. At least 32 characters of `A-Z a-z 0-9 _ -`. |
| `FRAMER_API_KEY` | Sync mode only | Framer Server API key for the site's Framer project, created by its owner or a Full access member, never a Content Editor (see [The Framer key](#the-framer-key)). Replaced when the project is transferred. Not used in capture mode. |

## Manual steps

```sh
npm ci
npm run check                                       # typecheck, tests, dry-run build
npx wrangler login
npx wrangler kv namespace create jobadder-feed-capture
```

Put the returned ID in `wrangler.jsonc` in place of `<KV_NAMESPACE_ID>`, and the hostname in place
of `<FEED_HOSTNAME>`. The domain must be a zone in the same Cloudflare account; `custom_domain:
true` makes Cloudflare create the DNS record and certificate. `workers_dev` and preview URLs stay
off, so the hostname is the only way in. If the login reaches several accounts, add
`"account_id": "<id>"` too.

To use R2 instead of KV: create a bucket, set `CAPTURE_STORE` to `"r2"`, and swap the
`kv_namespaces` block for the commented `r2_buckets` block.

Set the secrets, then deploy:

```sh
npx wrangler secret put FEED_BASIC_AUTH_USER
npx wrangler secret put FEED_BASIC_AUTH_PASS        # 24+ characters, e.g. from: openssl rand -hex 24
npx wrangler deploy
```

Smoke test. Only the latest feed is stored, so posting a feed with the right login replaces it.
The first line therefore proves the login with a body the Worker refuses after the login check,
and stores nothing:

```sh
# Expect "bad request" (login accepted, nothing stored). curl prompts for the password,
# keeping it out of shell history.
curl -sS -u '<username>' -H 'Content-Type: application/xml' --data-binary 'setup-probe' https://<FEED_HOSTNAME>/ # gitleaks:allow (placeholder username)
# Before JobAdder's first push only, this also proves storage. Expect "ok".
curl -sS -u '<username>' -H 'Content-Type: application/xml' --data-binary '<Jobs/>' https://<FEED_HOSTNAME>/
# Expect "unauthorized".
curl -sS -u "wrong:wrong" --data-binary '<Jobs/>' https://<FEED_HOSTNAME>/
```

Export a capture by hand (then remove every `Apply/EmailTo` element before sending it on):

```sh
npx wrangler kv key list --binding FEED_CAPTURE --remote     # metadata only
npx wrangler kv key get latest.xml --binding FEED_CAPTURE --remote --text > latest.xml
# R2: npx wrangler r2 object get <R2_BUCKET_NAME>/latest.xml --remote --file latest.xml
```

Plain HTTP is always refused by the Worker. If the zone has "Always Use HTTPS" on, Cloudflare may
redirect an `http://` request before it reaches the Worker; either way the URL given to JobAdder
must start with `https://`.

## What the first capture proves

| Check | How |
|---|---|
| JobAdder can POST to HTTPS with basic auth | A capture exists and the Worker log shows `"outcome":"accepted"` |
| The board sends XML | Metadata `root` is `Jobs`; `contentType` shows what JobAdder sent |
| Ad IDs line up | Each `Job/@jid` equals the ad ID in that ad's apply URL |

If the log shows only `"reason":"no_credentials"` or `"bad_credentials"` with no accepted
request, JobAdder's sender is not sending basic auth: use the fallback below.

## Fallback: unguessable path (if basic auth does not work)

Still HTTPS only; never plain HTTP. Setup does not handle this mode; do it by hand.

```sh
openssl rand -hex 24          # use the output as the path secret
npx wrangler secret put FEED_PATH_SECRET
```

Set `"FEED_AUTH_MODE": "path"` in `wrangler.jsonc`, redeploy with `npx wrangler deploy`, and give
JobAdder the URL `https://<FEED_HOSTNAME>/<FEED_PATH_SECRET value>` with no username or password.
Any other path returns 404. Treat the full URL as a password: anyone who sees it can post. The
basic-auth secrets can be deleted with `npx wrangler secret delete`.

The Worker never logs the path, but Cloudflare's zone-level records do: HTTP traffic analytics,
security (WAF) events and any Logpush job include the request path, so in path mode they contain
the secret. Limit who can view them on the account.

## Switching on the jobs fallback

The fallback is a public `GET https://<FEED_HOSTNAME>/jobs.json` listing the
live ads from the latest push, for the site's `JobsFallback` component to show if the CMS sync is
unavailable. It ships switched off. It does not change the feed: JobAdder's POST, its login and
its URL stay exactly as they are, and the fallback needs none of the feed's secrets.

Switch it on only when told to (whoever runs the site decides when the fallback is used):

1. In `wrangler.jsonc`, set `"JOBS_FALLBACK": "on"` and add `"SITE_ORIGIN": "https://www.<SITE_DOMAIN>"`
   under `vars`: the site's address exactly as the browser shows it, `https://`, no path, no
   trailing slash. A site served on two hostnames (with and without `www`) uses the one visitors
   land on.
2. Redeploy: `npx wrangler deploy`.
3. Check it:

   ```sh
   # Expect 200, the site origin in Access-Control-Allow-Origin, and a JSON list of jobs.
   curl -sS -i https://<FEED_HOSTNAME>/jobs.json
   # Expect no output: the applications address (Apply/EmailTo) is never served.
   curl -sS https://<FEED_HOSTNAME>/jobs.json | grep -i 'emailto\|mailto'
   ```

   A 503 with `"setting":"SITE_ORIGIN"` in the Worker log means `SITE_ORIGIN` is not a bare https
   origin. A 503 with `"reason":"no_capture"` means no push has arrived yet. The feed keeps working
   either way.
4. The site side then sets the component's Endpoint to `https://<FEED_HOSTNAME>/jobs.json`
   (see `framer/README.md`).

The list is cached for 5 minutes, so a new push shows on the site within 5 minutes. To switch it
off: clear the component's Endpoint first, then set `"JOBS_FALLBACK": "off"` and redeploy. While
off, `/jobs.json` answers 404 like any other unknown path.

## Responses and logs

| Status | Meaning |
|---|---|
| 200 | Stored |
| 400 | Empty, not UTF-8, not well-formed XML, or contains a DTD |
| 401 | Missing or wrong basic-auth login |
| 403 | Plain HTTP |
| 404 | Wrong path (in path mode, also a wrong secret) |
| 405 | Not a POST |
| 413 | Body over `MAX_BODY_BYTES` (default 5,000,000) |
| 500 | Storage write failed; JobAdder may retry |
| 503 | Misconfigured: see the log's `setting` field |

Response bodies are fixed strings. Nothing from the request is echoed.

Each request writes one JSON log line (`event: "feed_request"`) with only: outcome, status,
reason, setting, size, root element, content type, a SHA-256 prefix and duration. It never
contains the payload, any header, the login, the URL or path, or the sender's address.
Cloudflare's own invocation logs are disabled in `wrangler.jsonc` because they record the URL;
in path mode that URL contains the secret, so keep them off.

`GET /status` answers 200 with the [status page](#status-page) or 403 over plain HTTP, and writes
its own line (`event: "status_request"`) with only outcome, status, reason, cache hit or miss and
duration. Any other method on `/status` is treated like any other feed request.

With the jobs fallback on, `GET /jobs.json` answers 200 (the list), 204 (a browser's CORS
preflight), 403 (plain HTTP) or 503 (misconfigured, no push yet, or the stored push is not a jobs
feed), and writes its own line (`event: "jobs_request"`) with only outcome, status, reason,
setting, cache hit or miss, job count and duration.

## Status page

`GET https://<FEED_HOSTNAME>/status` (or `HEAD`) answers without a login, in both auth modes, with
a small JSON summary. It is public by design and holds no secret, no setting's value, no hostname
and no job text:

| Field | Meaning |
|---|---|
| `version` | The release this code is (from `package.json`) |
| `deployment` | Cloudflare's version id and upload time. A dashboard settings edit also makes a new one, so a changed id with the same `version` means settings changed, not code |
| `feed_mode` | `capture`, `sync`, or `invalid` (the value itself is never shown) |
| `config` | `ok`, or `{"invalid": "<SETTING>"}` naming the first bad setting. While it is invalid every push is refused with 503 |
| `jobs_fallback` | `off`, `ok`, or the invalid setting |
| `mass_removal_override` | Whether `ALLOW_MASS_REMOVAL_SHA` is set (remove it once its push has synced) |
| `records` | `ok`, or why `last_push` and `last_sync` could not be read (`unreadable`, `unset`); their nulls then mean nothing |
| `last_push` | When the last accepted push arrived, and its 12-character hash |
| `last_sync` | Sync mode: the last sync run's outcome, reason code, trigger, time, counts, whether it published, hash, duration and the release that ran it (`version`) |

The answer is cached for up to 30 seconds per Cloudflare location, but a new deployment (code or
settings) shows at once. A push or sync can therefore take up to about a minute to appear.
`last_sync` changes only when a sync actually runs, so on a quiet board its time can be days old,
and in capture mode it keeps the last sync from before the switch.

## Dependency audit

`npm audit` reports advisories in the development tools (wrangler and the local test runtime pull
in an image library, `sharp`). None of them is in the deployed Worker, whose runtime
dependencies are `fast-xml-parser` and Framer's `framer-api` (used in sync mode only):
`npm audit --omit=dev` shows the deployed set.


## Sync mode: switching sync on

In `sync` mode the Worker also writes the jobs in each push to the site's Framer project. It
upserts them into a managed CMS collection named `Jobs`, removes ads that are gone, then publishes
and deploys the site. The push is still stored and answered first. A failed sync never fails the
push, and the cron retries it every 30 minutes.

Sync is switched on **before** the Framer project is transferred to the client, on the project the
designer is building. The key used now therefore belongs to the designer and is replaced at the
transfer (see [When the Framer project is transferred](#when-the-framer-project-is-transferred)).
Leave `FEED_MODE` on `capture` until the site's Jobs pages are ready to be filled.

### Before the switch-on (the designer)

The designer does this in the Framer project (details in
[`framer/README.md`](../framer/README.md#for-the-designer)):

1. Creates a Server API key as the project's owner (see [The Framer key](#the-framer-key)).
2. Sends the key and the project id to whoever deploys, by password-manager share, never by email
   or chat. The project id is the 20 characters after `--` in the project URL.
3. Makes sure no hand-made CMS collection is named `Jobs`. The sync creates its own managed
   `Jobs` collection and never writes into a hand-made one; a same-named hand-made collection
   leaves the templates bound to the wrong one, or makes every sync fail at `framer_connect`.
4. Confirms that no customer-facing custom domain is connected to the project yet. Every sync that
   changes a job publishes **and deploys the whole project**, not only the CMS change (see the
   note below).

### Switch-on steps

Run these in one session, in this order:

1. **Deploy the release in capture mode first.** Get the latest release (v1.0.0 or later) into a new
   folder as in [Updating to a new release](#updating-to-a-new-release): `npm ci`,
   `npm run setup` (same account and address, `FEED_MODE` still `capture`), then
   `npm run setup -- --check`. The new code is now live on its own, before anything else changes:
   the status shown must say **Release** v1.0.0 or later and **Mode** `capture`.
2. **Store the key before switching mode.** A sync-mode deploy without it answers 503 to every push.

   ```sh
   npx wrangler secret put FRAMER_API_KEY
   ```

3. **Set the sync settings.** In that folder's `wrangler.jsonc`, under `vars`, set `"FEED_MODE":
   "sync"` and uncomment and fill:

   | Var | Value |
   |---|---|
   | `FRAMER_PROJECT_ID` | The bare 20-character project id |
   | `FRAMER_COLLECTION_NAME` | `Jobs` (keep it) |
   | `HIRING_ORG_NAME` | The client's name as it should appear in search results |
   | `HIRING_ORG_URL` | The site's https address, optional |
   | `JOB_COUNTRY` | Two-letter country code, for example `NZ` |
   | `SALARY_CURRENCY` | Three-letter code, only if salary is shown (the client's call) |

   Then deploy: `npx wrangler deploy`. Set them in this file, not in the dashboard: a later
   `npm run setup` keeps either, but a bare `npx wrangler deploy` resets the Worker to the file
   (see [Updating to a new release](#updating-to-a-new-release)).
   Run `npm run setup -- --check`: the status must say **Mode** `sync` and **Settings** `ok`. An
   invalid setting is named there, and every push is refused with 503 until it is fixed.
4. **Check the first sync.** No push is needed: within 30 minutes the cron syncs the stored
   capture. Run `npm run setup -- --check` again: **Last sync** must say `ok by cron`. (The same
   run is in the logs under Workers & Pages > the Worker > Observability as an
   `event: "jobs_sync"` line with `"outcome":"ok"`.) If the stored push is an empty board, it
   creates the `Jobs` collection and its fields, writes no items and publishes nothing.
5. **Prove a write.** Post or edit a test ad on the board. About 15 minutes later its push syncs,
   publishes and deploys. Check **Last sync** (`ok by push`, `published`, and note its `ms`), the
   item in the Framer CMS, and the job page on the project's published address.
6. Revoke any temporary deploy token.

Then point alerts at the operator of the Worker: login failure, parse failure and
`"outcome":"error"` on `jobs_sync`. Weekly, compare the site's job count with the board's live ad
count. If the sync breaks, check [Reading the sync logs](#reading-the-sync-logs) first.

**Every sync publishes the whole project.** Framer's Server API documents `publish()` as "Publish a
new preview link with all the changes" and `deploy()` as "Promote a published link to production".
Framer does not document whether that includes design work not yet published from the editor; take
it that it does. Before launch this means a job change also puts the designer's current canvas on
the project's published address.

### The Framer key

A key "authenticates as the user who created it" and is bound to one project (Framer's Server API
docs). Which user creates it matters:

- **Who can create one:** the project's owner, or a member with **Full access**. A **Content
  Editor** seat cannot: the API keys section in Site Settings > General is greyed out, with a
  "no design access" notice. (Tested on a scratch project; Framer does not document it.)
- **Before the transfer:** the designer, as the project's owner, creates it in Site Settings >
  General, API keys.
- **After the transfer:** the client's owner, or a Full access account that will stay, creates a
  new one. Recommended: the client's owner creates it and passes it securely to whoever deploys,
  who then needs no Framer seat. A Full access seat on a paid plan may cost money; check with
  Framer before choosing it.
- **Use an account that will stay.** If the key's user is later removed from the project,
  downgraded to Content Editor or View only, or the project is transferred again, the key stops
  writing and every sync fails at `framer_connect`. A key created by an account on a shared or
  role mailbox outlives staff changes.

### When the Framer project is transferred

The designer's key stops working at the transfer, because the sender is left on the project as
View only. Nothing else needs redoing: the collection, its items and the project id carry over,
and the Worker keeps its stored push.

What this rests on:

| Claim | Source |
|---|---|
| A key acts as the user who created it, on one project | Framer docs (Server API quick start) |
| A managed collection's items and fields are edited only by its manager, not in the editor | Framer docs (CMS, managed collections) |
| What happens to keys, CMS data or managed collections on a transfer | **Not documented by Framer** |
| The project id does not change | Tested on a scratch project, 2026-11-03 |
| The managed collection keeps its items and fields | Tested on a scratch project |
| A key from any owner or Full access user can write to the collection another user's key created | Tested on a scratch project |
| The sender's key stops writing: the first connect stalls about 60 s, then every one fails "opened view-only" | Tested on a scratch project |
| The same holds on the real project | Inference from the rehearsal; not run on the real project |
| No re-sync is needed after the new key goes in | Inference from the code: the cron re-runs every failed sync on the stored push |

Steps:

1. The client accepts the transfer.
2. The client's owner (or a Full access account that will stay) creates a new key, as in
   [The Framer key](#the-framer-key), and passes it securely to whoever deploys.
3. Replace the secret. No code deploy is needed:

   ```sh
   npx wrangler secret put FRAMER_API_KEY
   ```

4. Within 30 minutes the cron logs `jobs_sync` with `"outcome":"ok"` (it re-ran a sync that failed
   in the gap) or `"reason":"up_to_date"` (nothing was missed).
5. The client removes the designer's View only membership from the project. That also ends the old
   key for good.

Between the transfer and step 3, pushes are still stored and answered 200, but their syncs fail at
`framer_connect`. A push-time sync on a key that just lost access can hang past its 30-second
budget and end with no log line; the cron run that follows logs `framer_connect`. Keep the gap
short; the site catches up within 30 minutes of the new key.

### The launch push

Before launch the `Jobs` collection holds whatever test ads were posted on the board for the
designer to work against. At launch, expire them on the board; the next push removes them. Fewer
than `MASS_REMOVAL_MIN_ITEMS` (default 3) removals are never held, so one or two test ads go
without any step below.

When a push removes more than `MAX_REMOVAL_FRACTION` (default half) of the collection **and** at
least `MASS_REMOVAL_MIN_ITEMS` items, the removal part is held for safety:

1. The push writes its new and changed jobs, publishes, and logs `"outcome":"held"`,
   `"reason":"mass_removal_held"`. **The removed jobs are still on the live site** next to the
   new ones at this point. If the board renumbered its ads, the same job can show twice.
2. Copy the `sha256` value from that log line. It is 12 characters. `npm run setup -- --check`
   also prints it, on the **Last sync** warning, once the held run is the latest.
3. Set it in `wrangler.jsonc` under `vars`: `"ALLOW_MASS_REMOVAL_SHA": "<those 12 characters>"`,
   and redeploy with `npx wrangler deploy`.
4. Within 30 minutes the cron re-runs the held sync with the override and removes them. It logs
   `"outcome":"ok"` with `"removed"` equal to the number removed. If a new push arrives first, it
   has a different hash and is held again: repeat steps 2 and 3 with the newest held line's hash.
5. Remove `ALLOW_MASS_REMOVAL_SHA` and redeploy. It only ever applies to the one push whose hash
   it names, but leaving it in invites reuse. If it is forgotten, the next `npm run setup` asks
   whether to keep it and removes it by default.

Use the same steps any time a large, genuine removal is held, for example when most ads expire
at once. Check on the board first that the ads really are gone.

### Reading the sync logs

Each sync run writes one line, `event: "jobs_sync"`, with outcome, trigger (`push` or `cron`),
reason, counts, whether it published, a 12-character payload hash and duration. It never contains
job text, the key or an error message. A failed sync never fails the push itself: the push is
still stored and answered 200, and the cron retries every 30 minutes.

| Reason | Meaning | What to do |
|---|---|---|
| `framer_connect` | Could not open the project for editing | See below |
| `framer_write`, `framer_publish`, `framer_deploy` | Connected, then a write, publish or deploy failed | Usually a Framer outage; the cron retries. If it persists, see [Common failures](#common-failures) |
| `mass_removal_held` (outcome `held`) | Removals above `MAX_REMOVAL_FRACTION` of the collection, and at least `MASS_REMOVAL_MIN_ITEMS` of them, were held | [The launch push](#the-launch-push) |
| `no_usable_jobs`, `malformed_xml`, `not_jobs_root`, `not_utf8`, `doctype_not_allowed` (outcome `refused`) | The push was not a usable jobs feed; the site was left alone | Check the board's feed settings with JobAdder |
| `internal` | Building the items or closing the Framer session failed | A code fault: see [Common failures](#common-failures) |
| `store_failed` | KV or R2 read/write failed | Check the storage binding |
| `misconfigured` | A setting is missing or invalid; the `setting` field names it | Fix that setting and redeploy |
| `up_to_date`, `no_capture` (outcome `skipped`) | Cron found nothing to do: this release already synced the stored push, or there is none | Nothing |

**`framer_connect` on every run means an access problem, not a code fault.** The key no longer
has edit access to the project. Framer answers such a key with "This project opened view-only",
but the Worker never logs error messages, so `framer_connect` is all the log shows. Check, in
order:

1. Was the project just transferred? Then this is expected until the new key goes in: see
   [When the Framer project is transferred](#when-the-framer-project-is-transferred).
2. In the Framer project, open the member list. Does the key's user still have owner or Full
   access? If not, an owner or Full access account creates a new key (see
   [The Framer key](#the-framer-key)) and `FRAMER_API_KEY` is replaced.
3. Was the key revoked? Same fix.
4. Is `FRAMER_PROJECT_ID` still the bare 20-character id of the right project?

A key that has just lost access can also hang for up to a minute before failing. A push-time sync
has only 30 seconds after answering the push, so that run may end without a log line; the cron
run that follows logs `framer_connect`.
