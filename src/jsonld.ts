import type { Job } from "./jobs";

// schema.org JobPosting for each job page. The hiring organisation and
// country are deploy-time settings, never tracked values.

export interface JobPostingOptions {
  organisation: { name: string; url?: string };
  // ISO 3166-1 alpha-2, e.g. "NZ".
  country: string;
  // Off by default: whether to show pay is the client's call. Needs a currency.
  salary?: { currency: string };
}

// Keys are the label lower-cased with non-letters removed. A label naming two
// types ("Contract or Temp") maps to both; schema.org allows a list.
const EMPLOYMENT_TYPES: Record<string, string | string[]> = {
  fulltime: "FULL_TIME",
  permanent: "FULL_TIME",
  permanentfulltime: "FULL_TIME",
  parttime: "PART_TIME",
  contract: "CONTRACTOR",
  contractor: "CONTRACTOR",
  fixedterm: "CONTRACTOR",
  temp: "TEMPORARY",
  temporary: "TEMPORARY",
  contractortemp: ["CONTRACTOR", "TEMPORARY"],
  internship: "INTERN",
};

const SALARY_UNITS: Record<string, string> = {
  hourly: "HOUR",
  daily: "DAY",
  weekly: "WEEK",
  monthly: "MONTH",
  annual: "YEAR",
  yearly: "YEAR",
};

/**
 * Maps a board's work-type label to a schema.org employmentType. Labels are
 * set per board, so an unknown one is left out rather than guessed.
 */
export function employmentType(workType: string | undefined): string | string[] | undefined {
  return workType ? EMPLOYMENT_TYPES[workType.toLowerCase().replace(/[^a-z]/g, "")] : undefined;
}

/**
 * Builds the JobPosting object. `description` must already be sanitised.
 * validThrough is left out: the feed has no closing date, and a closed ad
 * simply drops out of the next push.
 */
export function jobPosting(job: Job, description: string, options: JobPostingOptions): Record<string, unknown> {
  const posting: Record<string, unknown> = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: description || job.summary || job.title,
    identifier: { "@type": "PropertyValue", name: options.organisation.name, value: job.id },
    hiringOrganization: {
      "@type": "Organization",
      name: options.organisation.name,
      ...(options.organisation.url ? { sameAs: options.organisation.url } : {}),
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        // A board-wide choice such as "All New Zealand" is not a region.
        ...(job.location && !/^all\b/i.test(job.location) ? { addressRegion: job.location } : {}),
        addressCountry: options.country,
      },
    },
    directApply: false,
  };
  if (job.datePosted) posting.datePosted = job.datePosted.slice(0, 10);
  const type = employmentType(job.workType);
  if (type) posting.employmentType = type;
  if (job.category) posting.industry = job.category;

  const unit = SALARY_UNITS[(job.salary?.period ?? "").toLowerCase()];
  const { min, max } = job.salary ?? {};
  if (options.salary && unit && (min !== undefined || max !== undefined)) {
    posting.baseSalary = {
      "@type": "MonetaryAmount",
      currency: options.salary.currency,
      value: {
        "@type": "QuantitativeValue",
        ...(min !== undefined ? { minValue: min } : {}),
        ...(max !== undefined ? { maxValue: max } : {}),
        unitText: unit,
      },
    };
  }
  return posting;
}

// Built from char codes so the source file holds no raw line terminators.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * Serialises for a <script type="application/ld+json"> block. "<" is escaped
 * so no value can close the script element, and the two JavaScript line
 * terminators are escaped for older parsers.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
