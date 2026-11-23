import { describe, expect, it } from "vitest";
import { JOB_FIELDS, toItem } from "../src/fields";
import { jobSlug, parseJobs, type Job } from "../src/jobs";
import { employmentType, jobPosting, serializeJsonLd } from "../src/jsonld";
import { sanitizeHtml } from "../src/sanitize";
import { FEED_XML, JOBS_XML, REAL_SHAPE_XML, REJECTS_XML } from "./fixtures";

const bytes = (s: string) => new TextEncoder().encode(s);
const OPTIONS = { organisation: { name: "Example Recruitment", url: "https://www.example.com/" }, country: "NZ" };

function parsed(xml: string): Job[] {
  const result = parseJobs(bytes(xml));
  if (!result.ok) throw new Error(result.reason);
  return result.jobs;
}

describe("parseJobs", () => {
  it("reads every documented field of a full ad", () => {
    const [job] = parsed(JOBS_XML);
    expect(job).toEqual({
      id: "2000001",
      reference: "EX-001",
      datePosted: "2026-10-01",
      dateUpdated: "2026-10-02T09:30:00",
      featured: true,
      title: "Senior Example Engineer",
      summary: "Lead a synthetic team on invented projects.",
      description: "<html><body><p>About the <strong>role</strong> &amp; team.</p><ul><li>One</li><li>Two</li></ul></body></html>",
      highlights: ["First point", "Second & point", "Third point"],
      category: "Engineering",
      subCategory: "Civil",
      location: "Example Region",
      workType: "Full Time",
      applyUrl: "https://apply.example.com/2000001",
      salary: { period: "Annual", min: 90000, max: 110000, text: "$90k to $110k" },
    });
  });

  it("keeps feed order and handles sparse ads", () => {
    const jobs = parsed(JOBS_XML);
    expect(jobs.map((j) => j.id)).toEqual(["2000001", "2000002", "2000003", "2000004", "2000005", "2000006"]);
    const sparse = jobs[2]!;
    expect(sparse).toMatchObject({ featured: false, description: "", highlights: [], workType: "Contract" });
    expect(sparse.dateUpdated).toBeUndefined();
    expect(sparse.salary).toBeUndefined();
    expect(jobs[3]!.salary).toEqual({ period: "Hourly", min: undefined, max: undefined, text: "Competitive hourly rate" });
    expect(jobs[5]!.title).toBe("Graduate <Trainee>");
  });

  it("never reads the applications email address", () => {
    const text = JSON.stringify(parsed(JOBS_XML));
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("EmailTo");
  });

  it("reads the shape of the first real push, ignoring the board's field dictionary", () => {
    const result = parseJobs(bytes(REAL_SHAPE_XML));
    expect(result).toMatchObject({ ok: true, rejected: [] });
    expect(parsed(REAL_SHAPE_XML)).toEqual([
      {
        id: "2000101",
        reference: "EX-101",
        datePosted: "2026-10-03",
        dateUpdated: "2026-10-02T22:00:00Z",
        featured: false,
        title: "Example Position",
        summary: "A synthetic summary.",
        description: "<strong>About us&nbsp;</strong><br>Invented text.<br> <ul> <li>One</li> </ul> We&rsquo;re hiring.",
        highlights: ["First point"],
        category: "Engineering & Design",
        subCategory: "Civil",
        location: "All Example Country",
        workType: "Contract or Temp",
        applyUrl: "https://apply.example.com/1000/2000101/exampleSourceKey?site=x",
        salary: undefined,
      },
    ]);
    expect(JSON.stringify(parsed(REAL_SHAPE_XML))).not.toContain("@example.com");
  });

  it("reads the single-ad fixture the capture tests use", () => {
    expect(parsed(FEED_XML)).toHaveLength(1);
  });

  it("leaves out ads that cannot be shown and says why, with no payload text", () => {
    const result = parseJobs(bytes(REJECTS_XML));
    expect(result).toEqual({
      ok: true,
      jobs: [expect.objectContaining({ id: "3000001", title: "Kept" })],
      rejected: [
        { reason: "missing_jid" },
        { reason: "bad_jid" },
        { jid: "3000001", reason: "duplicate_jid" },
        { jid: "3000002", reason: "missing_title" },
        { jid: "3000003", reason: "bad_apply_url" },
        { jid: "3000004", reason: "bad_apply_url" },
      ],
    });
  });

  it("reads an empty board as zero jobs, not an error", () => {
    expect(parseJobs(bytes("<Jobs/>"))).toEqual({ ok: true, jobs: [], rejected: [] });
    expect(parseJobs(bytes('<?xml version="1.0"?>\n<Jobs advertiser="x">\n</Jobs>'))).toEqual({ ok: true, jobs: [], rejected: [] });
    // The real shape of an emptied board: the field dictionary and no Job.
    const emptied = REAL_SHAPE_XML.replace(/\n  <Job [\s\S]*<\/Job>/, "");
    expect(emptied).not.toContain("<Job ");
    expect(parseJobs(bytes(emptied))).toEqual({ ok: true, jobs: [], rejected: [] });
  });

  it("accepts classifications without the wrapper element", () => {
    const [job] = parsed('<Jobs><Job jid="1"><Title>T</Title><Classification name="Location">Here</Classification><Apply><Url>https://a.example.com/</Url></Apply></Job></Jobs>');
    expect(job!.location).toBe("Here");
  });

  it("normalises the id so the same ad always maps to the same item", () => {
    expect(parsed('<Jobs><Job jid="007"><Title>T</Title><Apply><Url>https://a.example.com/</Url></Apply></Job></Jobs>')[0]!.id).toBe("7");
  });

  it("refuses payloads that are not a jobs feed", () => {
    expect(parseJobs(bytes("<Other/>"))).toEqual({ ok: false, reason: "not_jobs_root" });
    expect(parseJobs(bytes("<Jobs>"))).toEqual({ ok: false, reason: "malformed_xml" });
    expect(parseJobs(bytes('<!DOCTYPE Jobs [<!ENTITY x "y">]><Jobs/>'))).toEqual({ ok: false, reason: "doctype_not_allowed" });
    expect(parseJobs(new Uint8Array([0x3c, 0xff, 0x3e]))).toEqual({ ok: false, reason: "not_utf8" });
  });
});

describe("jobSlug", () => {
  it("is the title in URL form plus the ad id", () => {
    expect(jobSlug({ id: "2000001", title: "Senior Example Engineer" })).toBe("senior-example-engineer-2000001");
  });

  it("strips accents and cuts a long title at a word boundary", () => {
    const slug = jobSlug({ id: "2000002", title: parsed(JOBS_XML)[1]!.title });
    expect(slug).toBe("cafe-coordinator-evenements-hospitality-and-front-of-house-2000002");
    expect(slug.length).toBeLessThanOrEqual(61 + 8);
  });

  it("falls back when the title has no letters or digits", () => {
    expect(jobSlug({ id: "5", title: "★ ★" })).toBe("job-5");
  });
});

describe("sanitizeHtml", () => {
  it("keeps the allowed structure and unwraps document wrappers", async () => {
    expect(await sanitizeHtml(parsed(JOBS_XML)[0]!.description)).toBe(
      "<p>About the <strong>role</strong> &amp; team.</p><ul><li>One</li><li>Two</li></ul>",
    );
  });

  it("removes scripts, handlers, styles, comments, images and unsafe links", async () => {
    const out = await sanitizeHtml(parsed(JOBS_XML)[1]!.description);
    expect(out).toBe(
      '<p>Plain text inside a styled div.</p>bad link <a href="https://www.example.com/about" rel="nofollow noopener noreferrer">good link</a>',
    );
  });

  it("unwraps h1, so the job title stays the page's only h1", async () => {
    expect(await sanitizeHtml(parsed(JOBS_XML)[4]!.description)).toBe("Heading one<h2>Heading two</h2><p>Body.</p>");
  });

  it("drops a script even when the markup tries to close one early", async () => {
    const out = await sanitizeHtml(parsed(JOBS_XML)[5]!.description);
    expect(out).not.toMatch(/<\/?script/i);
    expect(out).not.toContain("alert");
  });

  it("removes stray end tags and split tag tricks", async () => {
    expect(await sanitizeHtml("<p>a</div></body></html>b</p>")).toBe("<p>ab</p>");
    const out = await sanitizeHtml("<scr<script>ipt>alert(1)</script><p>ok</p>");
    expect(out).not.toMatch(/<\/?script/i);
    expect(out).toContain("<p>ok</p>");
  });

  // The parser reads these elements' content as raw text, so unwrapping one
  // would emit its content verbatim: live markup in the page.
  it.each(["xmp", "noembed", "noframes", "plaintext", "noscript", "iframe", "style", "textarea", "title", "script"])(
    "drops raw-text element %s with its content",
    async (tag) => {
      const out = await sanitizeHtml(`<p>ok</p><${tag}><img src=x onerror=alert(1)><b>x</b></${tag}>`);
      expect(out).not.toMatch(/<img|onerror|alert/i);
      const startTags = [...out.matchAll(/<([A-Za-z][^\s/>]*)/g)].map((m) => m[1]!.toLowerCase());
      expect(startTags.every((t) => ["p", "b"].includes(t))).toBe(true);
      expect(out).toContain("<p>ok</p>");
    },
  );

  // Markup the rewriter passes through verbatim. A tag left open at the end
  // turns live once the site puts any markup after the description.
  it.each([
    ["an unclosed tag at the end", "<p>x<img src=x onerror=alert(1)//", "<p>x&lt;img src=x onerror=alert(1)//"],
    ["an unclosed script tag at the end", "<p>x<script", "<p>x&lt;script"],
    ["an unclosed link at the end", '<p>x<a href="https://e.example/', '<p>x&lt;a href="https://e.example/'],
    ["an end tag whose attribute swallows a script tag", '<p>x</p a=">"<script>alert(1)</script>', '<p>x</p>"&lt;script>alert(1)'],
    ["an end tag with whitespace", "<p>a</p\n><b>c</b >", "<p>a</p><b>c</b>"],
    ["upper-case tags", "<SCRIPT>alert(1)</SCRIPT><P>ok</P>", "<p>ok</p>"],
    ["a bare less-than in text", "<p>1 < 2</p>", "<p>1 &lt; 2</p>"],
  ])("escapes or rebuilds %s", async (_name, input, expected) => {
    const out = await sanitizeHtml(input);
    expect(out).toBe(expected);
    expect(await sanitizeHtml(out)).toBe(out);
  });

  // Every "<" left in the output starts a bare allowed tag, or a link with
  // exactly the href and rel the sanitizer set.
  it.each([
    "<p>a<?x <img src=x onerror=alert(1)> ?>b</p>",
    "<p>a<!x <img src=x onerror=alert(1)>>b</p>",
    "<p>a<![CDATA[<img src=x onerror=alert(1)>]]>b</p>",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    "<table><svg><p><style><img src=x onerror=alert(1)></style>",
    "<!--><img src=x onerror=alert(1)>-->",
    '<a href="https://e.example/?q=&quot;onmouseover=alert(1)">l</a>',
    '<a href=" javascript:alert(1)">l</a><a href="java&#x09;script:alert(1)">m</a>',
    "<b/onclick=alert(1)>x</b>",
    '<p>x</p a="<script>alert(1)</script>">',
  ])("leaves only allowed markup for %s", async (input) => {
    const out = await sanitizeHtml(input);
    const allowed = /^<\/?(?:p|br|strong|b|em|i|u|ul|ol|li|h2|h3|h4|blockquote)>$|^<a href="https?:[^"<>]*" rel="nofollow noopener noreferrer">$|^<\/a>$/;
    for (const [tag] of out.matchAll(/<[^>]*>?/g)) expect(tag).toMatch(allowed);
    expect(out).not.toMatch(/onerror|onclick|javascript:/i);
    expect(await sanitizeHtml(out)).toBe(out);
  });

  it("refuses mailto and data links", async () => {
    expect(await sanitizeHtml('<a href="mailto:person@example.com">x</a><a href="data:text/html,x">y</a>')).toBe("xy");
  });

  it("returns an empty string for an empty description", async () => {
    expect(await sanitizeHtml("  ")).toBe("");
  });
});

describe("JobPosting structured data", () => {
  it("maps a full ad", () => {
    const job = parsed(JOBS_XML)[0]!;
    expect(jobPosting(job, "<p>d</p>", OPTIONS)).toEqual({
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: "Senior Example Engineer",
      description: "<p>d</p>",
      identifier: { "@type": "PropertyValue", name: "Example Recruitment", value: "2000001" },
      hiringOrganization: { "@type": "Organization", name: "Example Recruitment", sameAs: "https://www.example.com/" },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressRegion: "Example Region", addressCountry: "NZ" } },
      directApply: false,
      datePosted: "2026-10-01",
      employmentType: "FULL_TIME",
      industry: "Engineering",
    });
  });

  it("leaves pay out unless it is switched on", () => {
    const job = parsed(JOBS_XML)[0]!;
    expect(jobPosting(job, "", OPTIONS)).not.toHaveProperty("baseSalary");
    expect(jobPosting(job, "", { ...OPTIONS, salary: { currency: "NZD" } }).baseSalary).toEqual({
      "@type": "MonetaryAmount",
      currency: "NZD",
      value: { "@type": "QuantitativeValue", minValue: 90000, maxValue: 110000, unitText: "YEAR" },
    });
  });

  it("falls back to the summary when there is no description", () => {
    expect(jobPosting(parsed(JOBS_XML)[2]!, "", OPTIONS).description).toBe("No salary, no bullets, no description.");
  });

  it("maps known work types and leaves unknown ones out", () => {
    expect(["Full Time", "Part Time", "Contract", "Temp", "Fixed Term", "Casual", undefined].map(employmentType)).toEqual([
      "FULL_TIME", "PART_TIME", "CONTRACTOR", "TEMPORARY", "CONTRACTOR", undefined, undefined,
    ]);
  });

  it("maps the work-type labels of the first real board", () => {
    expect(["Permanent / Full Time", "Contract or Temp", "Part-time", "Casual"].map(employmentType)).toEqual([
      "FULL_TIME", ["CONTRACTOR", "TEMPORARY"], "PART_TIME", undefined,
    ]);
  });

  it("gives no region for a board-wide location choice", () => {
    const job = parsed(REAL_SHAPE_XML)[0]!;
    expect(jobPosting(job, "", OPTIONS).jobLocation).toEqual({ "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "NZ" } });
    expect(jobPosting(job, "", OPTIONS).employmentType).toEqual(["CONTRACTOR", "TEMPORARY"]);
  });

  it("serialises so that no value can close the script element", () => {
    const LS = String.fromCharCode(0x2028);
    const out = serializeJsonLd({ title: "</script><script>alert(1)</script>", x: LS });
    expect(out).not.toContain("<");
    expect(out).not.toContain(LS);
    expect(JSON.parse(out)).toEqual({ title: "</script><script>alert(1)</script>", x: LS });
  });
});

describe("collection items", () => {
  it("fills every field in the schema, with the ad id as the item id", async () => {
    const item = await toItem(parsed(JOBS_XML)[0]!, OPTIONS);
    expect(item.id).toBe("2000001");
    expect(item.slug).toBe("senior-example-engineer-2000001");
    expect(Object.keys(item.fieldData).sort()).toEqual(JOB_FIELDS.map((f) => f.id).sort());
    for (const field of JOB_FIELDS) expect(item.fieldData[field.id].type).toBe(field.type);
    expect(item.fieldData.highlights.value).toBe("<ul><li>First point</li><li>Second &#38; point</li><li>Third point</li></ul>");
    expect(item.fieldData.applyUrl.value).toBe("https://apply.example.com/2000001");
    expect(JSON.parse(item.fieldData.jsonLd.value as string).description).toBe(item.fieldData.description.value);
  });

  it("uses empty values, not missing fields, for a sparse ad", async () => {
    const item = await toItem(parsed(JOBS_XML)[2]!, OPTIONS);
    expect(item.fieldData.highlights).toEqual({ type: "formattedText", value: "" });
    expect(item.fieldData.dateUpdated).toEqual({ type: "date", value: null });
    expect(item.fieldData.salaryText).toEqual({ type: "string", value: "" });
  });

  it("escapes markup in highlights", async () => {
    const job = { ...parsed(JOBS_XML)[0]!, highlights: ["<b>x</b>"] };
    expect((await toItem(job, OPTIONS)).fieldData.highlights.value).toBe("<ul><li>&#60;b&#62;x&#60;/b&#62;</li></ul>");
  });

  it("has unique, stable field ids", () => {
    expect(new Set(JOB_FIELDS.map((f) => f.id)).size).toBe(JOB_FIELDS.length);
  });
});
