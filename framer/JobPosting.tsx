// JobPosting: a Framer code component that puts a job's schema.org
// JobPosting structured data on its CMS page. Place it once on the Job CMS
// template and bind its JSON-LD control to the collection's "JSON-LD" field.
// It renders nothing visible.
//
// The Worker already builds and escapes the value (src/jsonld.ts). This
// component checks it again: it must parse as a JobPosting object, and it is
// re-serialised with "<" and the two JavaScript line terminators escaped, so
// a wrongly bound field cannot close the script element.

import { addPropertyControls, ControlType } from "framer"

interface Props {
    jsonLd: string
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */
export default function JobPosting({ jsonLd }: Props) {
    const value = jobPosting(jsonLd)
    if (!value) return null
    // Not HTML: serialize() emits JSON with every "<" escaped, so it can hold
    // no markup and cannot close the element. React would entity-escape a text
    // child, which breaks JSON inside a script element.
    // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
    return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serialize(value) }} />
}

function jobPosting(raw: string): Record<string, unknown> | null {
    if (!raw) return null
    try {
        const value: unknown = JSON.parse(raw)
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const posting = value as Record<string, unknown>
            if (posting["@type"] === "JobPosting" && typeof posting.title === "string") return posting
        }
    } catch {
        // Not JSON: render nothing.
    }
    return null
}

// Built from char codes so the source file holds no raw line terminators.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g")
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g")

function serialize(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(LINE_SEPARATOR, "\\u2028")
        .replace(PARAGRAPH_SEPARATOR, "\\u2029")
}

JobPosting.defaultProps = { jsonLd: "" }

addPropertyControls(JobPosting, {
    jsonLd: {
        type: ControlType.String,
        title: "JSON-LD",
        description: "Bind to the Jobs collection's JSON-LD field.",
    },
})
