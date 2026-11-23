import { jobSlug, type Job } from "./jobs";
import { jobPosting, serializeJsonLd, type JobPostingOptions } from "./jsonld";
import { escapeHtml, sanitizeHtml } from "./sanitize";

// The Jobs collection on the site: the contract between this code and the
// site build. Field ids are stable; the site's templates bind to them. Change
// this list additively only, or the bound templates break.

export type FieldType = "string" | "formattedText" | "date" | "boolean" | "link";

export interface JobField {
  id: string;
  name: string;
  type: FieldType;
}

export const JOB_FIELDS = [
  { id: "title", name: "Title", type: "string" },
  { id: "summary", name: "Summary", type: "string" },
  { id: "description", name: "Description", type: "formattedText" },
  { id: "highlights", name: "Highlights", type: "formattedText" },
  { id: "category", name: "Category", type: "string" },
  { id: "subCategory", name: "Sub Category", type: "string" },
  { id: "location", name: "Location", type: "string" },
  { id: "workType", name: "Work Type", type: "string" },
  { id: "datePosted", name: "Date Posted", type: "date" },
  { id: "dateUpdated", name: "Date Updated", type: "date" },
  { id: "featured", name: "Featured", type: "boolean" },
  { id: "applyUrl", name: "Apply URL", type: "link" },
  { id: "salaryText", name: "Salary Text", type: "string" },
  { id: "reference", name: "Reference", type: "string" },
  { id: "jsonLd", name: "JSON-LD", type: "string" },
] as const satisfies readonly JobField[];

export type JobFieldId = (typeof JOB_FIELDS)[number]["id"];

type FieldValue =
  | { type: "string" | "formattedText"; value: string }
  | { type: "date" | "link"; value: string | null }
  | { type: "boolean"; value: boolean };

export interface JobItem {
  // The ad id, so a re-push of the same ad updates the same item.
  id: string;
  slug: string;
  fieldData: Record<JobFieldId, FieldValue>;
}

/** One collection item for a job, in the shape the site's CMS accepts. */
export async function toItem(job: Job, options: JobPostingOptions): Promise<JobItem> {
  const description = await sanitizeHtml(job.description);
  const highlights = job.highlights.length
    ? `<ul>${job.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
    : "";
  const str = (value: string | undefined) => ({ type: "string", value: value ?? "" }) as const;
  return {
    id: job.id,
    slug: jobSlug(job),
    fieldData: {
      title: str(job.title),
      summary: str(job.summary),
      description: { type: "formattedText", value: description },
      highlights: { type: "formattedText", value: highlights },
      category: str(job.category),
      subCategory: str(job.subCategory),
      location: str(job.location),
      workType: str(job.workType),
      datePosted: { type: "date", value: job.datePosted ?? null },
      dateUpdated: { type: "date", value: job.dateUpdated ?? null },
      featured: { type: "boolean", value: job.featured },
      applyUrl: { type: "link", value: job.applyUrl },
      salaryText: str(job.salary?.text),
      reference: str(job.reference),
      jsonLd: str(serializeJsonLd(jobPosting(job, description, options))),
    },
  };
}
