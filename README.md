# jobadder-framer-sync

A Cloudflare Worker that receives the job ads a JobAdder board pushes, and keeps a Framer site's
Jobs collection in step with them. It runs in the site owner's own Cloudflare account. Everything
needed to deploy, run and repair it is in this repository; no outside account, contact or approval
is needed.

## What it does

In words, one push from start to finish:

1. **JobAdder pushes.** Whenever an ad on the board is posted, edited or expired, JobAdder sends
   the whole board as XML by HTTPS POST to the Worker's address, with a username and password.
2. **The Worker checks it.** It refuses anything without the right login (before reading the
   body), anything over 5 MB, and anything that is not well-formed UTF-8 XML. DTDs are refused.
3. **The Worker stores it.** The latest push is kept in Cloudflare KV (or R2) as `latest.xml`, and
   the Worker answers JobAdder with 200. Only the latest push is kept.
4. **Sync mode only: the Worker updates the site.** In the background, it reads the jobs from the
   push, cleans each description, and makes the site's managed `Jobs` collection in Framer match:
   new and changed ads are written, gone ads are removed, then the site is published. A large
   removal is held for a person to confirm. A cron re-runs a failed sync every 30 minutes.
5. **Anyone can check it.** `GET /status` shows the release, mode, settings health and the last
   push and sync, with no login and no secret in it.
6. **Optional fallback.** `GET /jobs.json` serves a plain public list of the live ads, for a Framer
   code component to show if the CMS sync is ever unavailable. Off by default.

```text
JobAdder board --HTTPS POST + login--> Worker --stores--> KV/R2 (latest.xml)
                                         |
                                         +--sync mode--> Framer Server API --> Jobs collection --> published site
                                         +--GET /status (public health)
                                         +--GET /jobs.json (optional fallback list)
```

The Worker deploys in **capture mode** (steps 1 to 3 and 5). **Sync mode** adds step 4 and is
switched on separately, once the site's Jobs pages are built.

## If you are picking this up

You do not need anything from the people who wrote this. You need the site owner's own accounts:

| What | Who provides it |
|---|---|
| A Cloudflare login to the site owner's account, with permission to edit Workers, KV and DNS, on the Workers Paid plan | The site owner (an Administrator on their Cloudflare account can add you) |
| The Framer project, and a Server API key for it (sync mode only) | The project's owner in Framer, or a member with Full access. A Content Editor seat cannot create a key |
| The JobAdder board number and the feed's username and password | The board number from the site owner's JobAdder account; the login is in the site owner's password manager |
| Node.js 22 or later, and git (optional) on the computer you deploy from | You |

**Where the secrets live.** By location only; no value is ever in this repository:

- **The site owner's password manager** holds the feed username and password, and the Framer
  Server API key.
- **Cloudflare** holds the same values as encrypted Worker secrets: Workers & Pages > the Worker
  (named `jobadder-feed-worker`) > Settings > Variables and Secrets. Cloudflare shows their names,
  never their values.
- **The Cloudflare account id, KV namespace id and the feed's hostname** are not secret. Read them
  in the Cloudflare dashboard; `npm run setup` finds them for you.

**Deploy or update.** From the latest release on this repository's Releases page:

```sh
npm ci
npm run setup               # first deploy, or an update: keeps the live settings and login
npm run setup -- --check    # shows /status and tests the login, changes nothing
```

`npm run setup` drives `wrangler` (Cloudflare's CLI, installed by `npm ci`). Step by step, with
what to expect on screen: [docs/DEPLOY.md](docs/DEPLOY.md).

**Routine jobs.**

- **Rotate the feed password:** `npm run setup -- --rotate`, then send JobAdder support the
  printed email. See [Rotating the feed password](docs/DEPLOY.md#rotating-the-feed-password).
- **Rotate the Framer key:** the key acts as the Framer user who created it. It stops working if
  that person leaves the project, loses Full access or deletes it, or when the project is
  transferred. If it has an expiry date, replace it before then. See
  [Rotating the Framer key](docs/DEPLOY.md#rotating-the-framer-key).
- **Read the logs:** Cloudflare dashboard > Workers & Pages > `jobadder-feed-worker` >
  **Observability**. One JSON line per request or sync run (`feed_request`, `jobs_sync`,
  `status_request`, `jobs_request`), never with job text or secrets. See
  [Responses and logs](docs/DEPLOY.md#responses-and-logs) and
  [Reading the sync logs](docs/DEPLOY.md#reading-the-sync-logs).
- **Check health:** open `https://<feed hostname>/status`. See
  [Status page](docs/DEPLOY.md#status-page).
- **Something broke:** [Common failures](docs/DEPLOY.md#common-failures). If Framer or JobAdder
  change their side, fix the code in your own copy (fork this repository), run `npm run check`,
  and deploy with `npm run setup`.

## Contact and security

- **Security problems:** report them privately, as described in [SECURITY.md](SECURITY.md). Never
  in a public issue.
- **Anything else** (questions, bugs, ideas): open a GitHub issue on this repository.

## Licence

MIT. See [LICENSE](LICENSE). You may use, change and redeploy this code freely.

## Behaviour

- HTTPS only. Plain HTTP gets 403, never a redirect.
- Auth, set by `FEED_AUTH_MODE`:
  - `basic` (default): HTTP basic auth, compared in constant time.
  - `path`: an unguessable path secret, compared in constant time. The fallback if the sender
    cannot do basic auth.
- POST only; body capped by `MAX_BODY_BYTES` (checked while streaming, not just by header).
- Strict UTF-8, well-formed XML, one root element, no DTD.
- Fails closed: a missing or weak secret, an unknown mode or a missing binding gives 503.
- Responses never echo input. Logs are one allow-listed JSON line per request, with no payload,
  headers, credentials, URL or client address.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `FEED_MODE` | `capture` | `capture`, or `sync` (see Sync mode below) |
| `FEED_AUTH_MODE` | `basic` | `basic` or `path` |
| `FEED_PATH` | `/` | Basic mode only |
| `MAX_BODY_BYTES` | `5000000` | 1 to 20,000,000 |
| `CAPTURE_STORE` | `kv` | `kv` or `r2` |
| `CAPTURE_BINDING` | `FEED_CAPTURE` | Name of the KV or R2 binding |
| `JOBS_FALLBACK` | `off` | `on` serves the public `GET /jobs.json`; anything else is off |
| `SITE_ORIGIN` | (none) | Needed when `JOBS_FALLBACK` is `on`: the site's https origin, e.g. `https://www.example.com` |
| `FRAMER_PROJECT_ID` | (none) | Sync mode: the bare 20-character project id, the part after `--` in the project URL `framer.com/projects/<Name>--<id>` |
| `FRAMER_COLLECTION_NAME` | `Jobs` | Sync mode: the managed collection the jobs go into |
| `MAX_REMOVAL_FRACTION` | `0.5` | Sync mode: removals above this share of the collection are held, if there are also at least `MASS_REMOVAL_MIN_ITEMS` of them |
| `MASS_REMOVAL_MIN_ITEMS` | `3` | Sync mode: fewer removals than this are never held, so routine expiries on a small board go through. `1` holds on the share alone |
| `ALLOW_MASS_REMOVAL_SHA` | (none) | Sync mode: the first 12 hex characters of one push's sha256; that push alone may remove more |
| `HIRING_ORG_NAME` | (none) | Sync mode: `hiringOrganization` in each job's structured data |
| `HIRING_ORG_URL` | (none) | Sync mode, optional: the organisation's https URL |
| `JOB_COUNTRY` | (none) | Sync mode: ISO 3166-1 alpha-2, e.g. `NZ` |
| `SALARY_CURRENCY` | (none) | Sync mode, optional: ISO 4217, e.g. `NZD`. Unset keeps pay out of the structured data |

Secrets: `FEED_BASIC_AUTH_USER`, `FEED_BASIC_AUTH_PASS` (basic), `FEED_PATH_SECRET` (path),
`FRAMER_API_KEY` (sync).

The stored object is `latest.xml`, with metadata `receivedAt`, `bytes`, `sha256`, `contentType`
and `root`.

## Jobs collection (for the site build)

`src/jobs.ts` reads the feed into typed jobs (Apply/EmailTo is never
read), `src/sanitize.ts` cleans each description to an allow-list, and `src/fields.ts` turns a job
into one item of the site's Jobs collection. That collection's fields are the contract with the
site's templates:

| Field id | Name | Type | From the feed |
|---|---|---|---|
| (item id) | | | `Job/@jid`, the upsert key |
| (slug) | | | `Title` in URL form plus `-<jid>`, giving `/jobs/<slug>-<jid>/` |
| `title` | Title | string | `Title` |
| `summary` | Summary | string | `Summary` |
| `description` | Description | formatted text | `Description`, sanitised |
| `highlights` | Highlights | formatted text | `BulletPoints`, as a list |
| `category` | Category | string | `Classification[@name="Category"]` |
| `subCategory` | Sub Category | string | `Classification[@name="Sub Category"]` |
| `location` | Location | string | `Classification[@name="Location"]` |
| `workType` | Work Type | string | `Classification[@name="Work Type"]` |
| `datePosted` | Date Posted | date | `@datePosted` |
| `dateUpdated` | Date Updated | date | `@dateUpdated` (date or date-time) |
| `featured` | Featured | boolean | `@hot` |
| `applyUrl` | Apply URL | link | `Apply/Url` (http or https only) |
| `salaryText` | Salary Text | string | `Salary/Text`; whether to show it is the client's call |
| `reference` | Reference | string | `@reference` |
| `jsonLd` | JSON-LD | string | the job's schema.org `JobPosting`, already safe to place in a script element |

Fields are only ever added, never renamed or removed, so bound templates keep working. An ad with no
id, no title or no usable apply link is left out and reported by reason code. The work-type map to
schema.org `employmentType` leaves unknown labels out; labels are set per board, so the map is
checked against the first real capture.

## Sync mode

`FEED_MODE=sync` makes the Jobs collection match each push. The sync talks to the
`FramerConnector` interface in `src/framer.ts`; the shipped connector is Framer's Server API client
(`framer-api`, pinned), one WebSocket connection per run, with the key sent in a request header and
never in the URL. A same-named collection that the key does not manage is refused, not written to.
The tests run against an in-memory fake (`test/fake-framer.ts`) and never reach Framer.

Tested 2026-10-27 from the Workers runtime (`wrangler dev`, workerd) against a scratch Framer
project, synthetic jobs only: connect, create the managed collection and its
fields, add, remove, publish and deploy all succeed, and an identical re-push writes and publishes
nothing. A sync of 6 jobs took about 4 seconds (connect about 1.3 s, publish about 1 s, each other
call about 0.3 s), well inside the 30 seconds the Worker has after answering a push. No
`nodejs_compat` flag is needed.

- The push is stored and answered 200 exactly as in capture mode, then synced in the background
  (`ctx.waitUntil`). A failed sync never fails the push.
- Each job is upserted by ad id; an item whose content has not changed since it was last written
  is skipped. Items not in the push are removed. The site is published and deployed only when
  something was written (or an earlier run wrote but did not deploy).
- Guards: a payload with no usable job (every ad rejected, or not a jobs feed) is refused and the
  site is left alone. A well-formed empty board is accepted, but removals above
  `MAX_REMOVAL_FRACTION` of the collection, when there are also at least `MASS_REMOVAL_MIN_ITEMS`
  (default 3) of them, are held and reported (`mass_removal_held`); the other writes still apply.
  So 2 of 2 ads expiring goes through, while an empty push over 6 is held. `ALLOW_MASS_REMOVAL_SHA` lets one named push through, e.g. the launch push
  that replaces the synthetic seed items.
- Status: `status.json` next to `latest.xml` holds the last run's payload hash, outcome, reason
  code and per-item hashes. No job text.
- Cron, every 30 minutes: re-runs the sync on the stored payload when the last run on it ended in
  `error` or `held`, or when it was never synced. An outage heals, and a hold keeps being reported
  until a new push or the override.
- One allow-listed log line per run (`event: "jobs_sync"`): outcome, trigger, reason code, counts,
  whether it published, a 12-character payload hash, duration. Never job text, the key or an error
  message.

Not handled: a push and a cron run overlapping. Both are idempotent upserts, so the worst case is a
second publish.

## Jobs fallback (off by default)

A fallback for when the CMS sync is unavailable: a public, read-only
`GET /jobs.json` on the same Worker, which the `JobsFallback` code component (`framer/`) renders as
a plain list. It gives no per-job page and no structured data, so the synced collection stays the
primary route.

- Off unless `JOBS_FALLBACK` is `on`. While off, `/jobs.json` is just another path on the feed
  host (404).
- Only GET, HEAD and OPTIONS on `/jobs.json` reach it. Every other request, a POST to that path
  included, takes the feed path exactly as before, so the feed's auth is unchanged. It needs none
  of the feed's secrets, and a fallback setting that is wrong answers 503 on `/jobs.json` only.
- Built from the stored `latest.xml` with the same parser as the sync, so `Apply/EmailTo` is never
  read. Each job carries `id`, `slug`, `title`, `summary`, `highlights`, `category`,
  `subCategory`, `location`, `workType`, `datePosted`, `featured` and `applyUrl`, plus a top-level
  `updatedAt` (when the push arrived). No description HTML, salary or reference. Fields are only
  ever added (`FALLBACK_JOB_FIELDS` in `src/fallback.ts`).
- `Access-Control-Allow-Origin` is `SITE_ORIGIN`. That stops other sites' scripts reading the list
  in a browser; it is not access control. The list is public by design: every ad on it is already
  public on the board.
- Cached at the edge for 5 minutes (`Cache-Control: public, max-age=300`), so a push shows within
  5 minutes. HTTPS only. Before the first push, or if the stored push is not a jobs feed, it
  answers 503 and caches nothing.
- One allow-listed log line per request (`event: "jobs_request"`): outcome, status, reason code,
  cache hit or miss, job count, duration.

How to switch it on and off: [docs/DEPLOY.md](docs/DEPLOY.md#switching-on-the-jobs-fallback).

## Status page

A public `GET /status` (and `HEAD`) so the live Worker can be checked from outside the site
owner's Cloudflare account, by someone with no login to it. Always on, no login, in both auth modes.

- Reports the release (`package.json` version, bundled at build), Cloudflare's version id and
  upload time (`version_metadata` binding), the mode, whether the settings are valid (the name of
  the first invalid one, never a value), the jobs fallback, whether a mass-removal override is set,
  and the last push and sync run (times, counts, reason codes, a 12-character payload hash).
- Read from two small records beside the capture: `last-push.json`, written as soon as a push is
  stored, and `last-sync.json`, written after each sync run. Each has one writer, so neither
  overwrites the other, and a failed write never changes a push's answer.
- Answered before the feed's settings are loaded, so it still answers when they are broken. Only
  GET and HEAD on `/status` reach it; a POST there takes the feed path unchanged.
- Cached for 30 seconds per location, keyed on the deployment id and ignoring the query string, so
  it cannot be used to drive store reads, and a new deploy shows at once.
- One allow-listed log line per request (`event: "status_request"`).
- `npm run setup -- --check` prints it, and warns when the live release differs from the folder's.

Fields and how to read them: [docs/DEPLOY.md](docs/DEPLOY.md#status-page).

## Development

```sh
npm ci
npm test          # vitest in workerd, with local KV and R2
npm run check     # typecheck, tests, dry-run build
```

`scripts/` holds the deploy tools: `setup.mjs` (`npm run setup`, guided deploy, rerunnable,
`--rotate`, `--check`) and `capture.mjs` (`npm run capture`, exports the latest capture with every
`EmailTo` removed). They use no dependencies beyond the repo's own; their pure helpers in
`scripts/lib/` are typechecked and tested with the Worker.

`wrangler.jsonc` holds placeholders only (`<FEED_HOSTNAME>`, `<KV_NAMESPACE_ID>`). Tracked files
must not name any site owner, job board, domain or account id: those are deploy-time settings,
filled in by `npm run setup` on the deploying computer and never committed.
