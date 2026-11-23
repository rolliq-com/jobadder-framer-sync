import { XMLParser } from "fast-xml-parser";
import { checkXml } from "./xml";

// Reads the JobAdder job-ads feed (the documented "Jobs on your Website" XML
// schema) into typed jobs. Apply/EmailTo is never read: the applications
// address may name a person, and the site links to Apply/Url instead.

export interface Salary {
  period?: string;
  min?: number;
  max?: number;
  text?: string;
}

export interface Job {
  // Job/@jid: the upsert key and the last segment of the job's URL.
  id: string;
  reference?: string;
  datePosted?: string;
  dateUpdated?: string;
  featured: boolean;
  title: string;
  summary: string;
  // Raw HTML from the feed. Sanitise it (sanitize.ts) before it reaches the site.
  description: string;
  highlights: string[];
  category?: string;
  subCategory?: string;
  location?: string;
  workType?: string;
  applyUrl: string;
  salary?: Salary;
}

// Reason codes only: nothing from the payload except the public ad id.
export type RejectReason = "missing_jid" | "bad_jid" | "duplicate_jid" | "missing_title" | "bad_apply_url";

export type ParseResult =
  | { ok: true; jobs: Job[]; rejected: { jid?: string; reason: RejectReason }[] }
  | { ok: false; reason: "not_utf8" | "doctype_not_allowed" | "malformed_xml" | "not_jobs_root" };

const ARRAYS = new Set(["Jobs.Job", "Jobs.Job.BulletPoints.BulletPoint", "Jobs.Job.Classifications.Classification", "Jobs.Job.Classification"]);

// Strings stay strings ("007" is not a number). Only the five XML entities are
// expanded: checkXml refuses any DTD, so no custom entity can exist.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  trimValues: true,
  isArray: (_name, jpath) => ARRAYS.has(String(jpath)),
});

type Node = Record<string, unknown>;

const JID = /^\d{1,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parses a feed payload. A job that cannot be shown (no id, no title, no usable
 * apply link) is left out and listed in `rejected`; the rest are returned in
 * feed order. The caller decides what a partial or empty result means.
 */
export function parseJobs(bytes: Uint8Array): ParseResult {
  const checked = checkXml(bytes);
  if (!checked.ok) return checked;
  if (checked.root !== "Jobs") return { ok: false, reason: "not_jobs_root" };

  let doc: Node;
  try {
    doc = parser.parse(new TextDecoder().decode(bytes)) as Node;
  } catch {
    return { ok: false, reason: "malformed_xml" };
  }
  const root = doc.Jobs;
  // An empty <Jobs/> parses to "": a board with no live ads.
  const nodes = isNode(root) && Array.isArray(root.Job) ? (root.Job as unknown[]) : [];

  const jobs: Job[] = [];
  const rejected: { jid?: string; reason: RejectReason }[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!isNode(node)) {
      rejected.push({ reason: "missing_jid" });
      continue;
    }
    const result = readJob(node);
    if ("reason" in result) {
      rejected.push(result);
      continue;
    }
    if (seen.has(result.id)) {
      rejected.push({ jid: result.id, reason: "duplicate_jid" });
      continue;
    }
    seen.add(result.id);
    jobs.push(result);
  }
  return { ok: true, jobs, rejected };
}

function readJob(node: Node): Job | { jid?: string; reason: RejectReason } {
  const rawJid = attr(node, "jid");
  if (rawJid === undefined) return { reason: "missing_jid" };
  if (!JID.test(rawJid)) return { reason: "bad_jid" };
  const id = String(Number(rawJid));

  const title = text(node.Title);
  if (!title) return { jid: id, reason: "missing_title" };

  const applyUrl = httpUrl(isNode(node.Apply) ? text(node.Apply.Url) : undefined);
  if (!applyUrl) return { jid: id, reason: "bad_apply_url" };

  const classifications = new Map<string, string>();
  const wrapper = isNode(node.Classifications) ? node.Classifications.Classification : undefined;
  for (const c of [...asArray(wrapper), ...asArray(node.Classification)]) {
    const name = isNode(c) ? attr(c, "name") : undefined;
    const value = text(c);
    if (name && value && !classifications.has(name)) classifications.set(name, value);
  }

  const bullets = isNode(node.BulletPoints) ? asArray(node.BulletPoints.BulletPoint) : [];

  return {
    id,
    reference: optional(attr(node, "reference")),
    datePosted: date(attr(node, "datePosted")),
    dateUpdated: date(attr(node, "dateUpdated")),
    featured: /^(true|1)$/i.test(attr(node, "hot") ?? ""),
    title,
    summary: text(node.Summary) ?? "",
    description: rawText(node.Description) ?? "",
    highlights: bullets.map(text).filter((b): b is string => !!b),
    category: classifications.get("Category"),
    subCategory: classifications.get("Sub Category"),
    location: classifications.get("Location"),
    workType: classifications.get("Work Type"),
    applyUrl,
    salary: salary(node.Salary),
  };
}

function salary(value: unknown): Salary | undefined {
  if (!isNode(value)) return undefined;
  const out: Salary = {
    period: optional(attr(value, "period")),
    min: number(text(value.MinValue)),
    max: number(text(value.MaxValue)),
    text: text(value.Text),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function attr(node: Node, name: string): string | undefined {
  const value = node[`@${name}`];
  return typeof value === "string" ? value.trim() : undefined;
}

// Element text with runs of whitespace collapsed, or undefined when empty.
function text(value: unknown): string | undefined {
  return optional(rawText(value)?.replace(/\s+/g, " "));
}

function rawText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (isNode(value) && typeof value["#text"] === "string") return value["#text"].trim();
  return undefined;
}

function optional(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function date(value: string | undefined): string | undefined {
  return value && DATE.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10))) ? value : undefined;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The item slug: the title in URL form plus the ad id, e.g. "senior-engineer-2000001". */
export function jobSlug(job: Pick<Job, "id" | "title">): string {
  const words = job.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Cut at a word boundary so a long title does not end mid-word.
  const cut = words.length > 60 ? words.slice(0, 61).replace(/-[^-]*$/, "") : words;
  return `${cut || "job"}-${job.id}`;
}
