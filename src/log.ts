// One structured line per request. Fields are an allow-list: never add the
// body, headers, credentials, the URL or path (path mode keeps a secret in
// it), or the client address.
export interface LogFields {
  outcome: "accepted" | "rejected" | "error";
  status: number;
  reason?: string;
  setting?: string;
  bytes?: number;
  root?: string;
  contentType?: string;
  sha256?: string;
  ms: number;
}

// The public jobs fallback (GET /jobs.json). Same rule: counts and reason
// codes only, never job text.
export interface JobsLogFields {
  outcome: "served" | "rejected" | "error";
  status: number;
  reason?: string;
  setting?: string;
  cache?: "hit" | "miss";
  jobs?: number;
  ms: number;
}

// GET /status. Same rule: outcome, status, reason code, cache and duration.
export interface StatusLogFields {
  outcome: "served" | "rejected";
  status: number;
  reason?: string;
  cache?: "hit" | "miss";
  ms: number;
}

// One line per sync run (sync mode). Counts and reason codes only: never job
// text, the Framer key or an error message, which can carry a URL.
export interface SyncLogFields {
  outcome: "ok" | "held" | "refused" | "error" | "skipped";
  trigger: "push" | "cron";
  reason?: string;
  setting?: string;
  jobs?: number;
  rejected?: number;
  upserted?: number;
  removed?: number;
  heldRemovals?: number;
  published?: boolean;
  sha256?: string;
  ms: number;
}

export function logSync(fields: SyncLogFields): void {
  write("jobs_sync", fields.outcome === "error" || fields.outcome === "held" || fields.outcome === "refused", fields);
}

export function logRequest(fields: LogFields): void {
  write("feed_request", fields.outcome === "error", fields);
}

export function logJobsRequest(fields: JobsLogFields): void {
  write("jobs_request", fields.outcome === "error", fields);
}

export function logStatusRequest(fields: StatusLogFields): void {
  write("status_request", false, fields);
}

function write(event: string, isError: boolean, fields: object): void {
  const line = JSON.stringify({ event, ...fields });
  if (isError) console.error(line);
  else console.log(line);
}
