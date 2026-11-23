# Framer code components

Source for the two code components that go into the site's Framer project. Each file is
self-contained: in Framer, create a code file with the same name (Assets, Code, New file) and paste
the file's contents. They import only `framer` and `react`, which Framer provides. They are not
part of the Worker build and this repo's checks do not compile them.

## For the designer

The jobs reach the site through a **managed** CMS collection named `Jobs`, which the Worker creates
and fills from the JobAdder board (sync mode, [docs/DEPLOY.md](../docs/DEPLOY.md#sync-mode-switching-sync-on)).
What the designer does in the Framer project:

1. **Create the API key, as the project's owner.** Site Settings > General, API keys. A Content
   Editor seat cannot create one. Send the key and the project id (the 20 characters after `--` in
   the project URL) to whoever deploys the Worker by password-manager share, never by email or
   chat. When the project is transferred to the client, this key stops working and the client
   creates a new one; nothing else on the site changes.
2. **Do not make a `Jobs` collection by hand.** Delete or rename any hand-made collection with
   that name before the switch-on. The Worker creates its own, and a hand-made one with the same
   name leaves the pages bound to the wrong collection.
3. **Bind the Jobs pages to the managed collection.** Its items and fields are read-only in the
   editor: they change only when the board changes. Test ads posted on the board fill it to
   design against. Each item's slug is the job title's words plus the ad id, for example
   `senior-accountant-1234567`. The fields:

   | Field | Type | Notes |
   |---|---|---|
   | Title | Plain text | |
   | Summary | Plain text | |
   | Description | Formatted text | Sanitised HTML from the ad |
   | Highlights | Formatted text | A bullet list, empty if the ad has none |
   | Category | Plain text | |
   | Sub Category | Plain text | |
   | Location | Plain text | |
   | Work Type | Plain text | |
   | Date Posted | Date | |
   | Date Updated | Date | |
   | Featured | Toggle | |
   | Apply URL | Link | The Apply button's target |
   | Salary Text | Plain text | Show or hide it as the client decides |
   | Reference | Plain text | Internal; usually not shown |
   | JSON-LD | Plain text | Bind to `JobPosting` only, never show it |

   Fields are only ever added, never renamed or removed, so bound pages do not break. The list is
   `JOB_FIELDS` in `src/fields.ts`.
4. **Place `JobPosting` on the Job template, and leave the `JobsFallback` slot empty** (below).
5. **Before launch, no custom domain.** Each time a job changes, the Worker publishes and deploys
   the whole project, so the editor's current state goes to the published address with it. Keep
   the client's domain off the project until launch.

## JobPosting

Puts each job's schema.org `JobPosting` structured data on its page.

1. Place one `JobPosting` instance on the Job CMS template (anywhere; it renders nothing visible).
2. Bind its **JSON-LD** control to the Jobs collection's `JSON-LD` field.

It renders only a value that parses as a `JobPosting` object, and escapes it again before writing
the script element. Not yet confirmed: that Framer pre-renders the script element into the
page HTML. If it does not, the same value goes into the template's custom code instead.

## JobsFallback

Lists the live ads from the Worker's public `GET /jobs.json`, for use only if the CMS sync is
unavailable. It gives no per-job page and no structured data.

1. Leave a slot for it on the Jobs index page. With **Endpoint** empty it renders nothing on the
   published site (the editor shows a dashed note), so it is off by default.
2. To switch it on: first switch the Worker side on (`JOBS_FALLBACK` and `SITE_ORIGIN`, see
   [docs/DEPLOY.md](../docs/DEPLOY.md#switching-on-the-jobs-fallback)), then set **Endpoint** to
   `https://<feed host>/jobs.json` and publish. Hide or unpublish the synced job list at the same
   time so jobs do not show twice.
3. To switch it off: clear **Endpoint** and publish, then set `JOBS_FALLBACK` back to `off`.

Controls: Apply label, the text shown when there are no jobs or the list cannot load, a maximum
count, and whether to show each summary. Featured ads come first. It shows title, location, work
type, summary and an Apply link (new tab) and never renders HTML from the feed.

The fields it reads must stay in `FALLBACK_JOB_FIELDS` in `src/fallback.ts`; a test checks this.
