// JobsFallback: a Framer code component that lists the live job ads from the
// Worker's public GET /jobs.json. It is for when
// the CMS sync is unavailable: it gives no per-job page and no structured
// data, so the synced Jobs collection stays the primary route.
//
// Off by default: with the Endpoint control empty it renders nothing on the
// published site. The Worker side is off too until JOBS_FALLBACK is "on".
// Renders text only (no HTML from the feed), and links only to http(s) apply
// URLs. Fields read here must exist in FALLBACK_JOB_FIELDS (src/fallback.ts);
// a test checks that.

import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useState } from "react"

type Job = {
    id: string
    title: string
    summary: string
    location: string | null
    workType: string | null
    featured: boolean
    applyUrl: string
}

type State =
    | { status: "loading" }
    | { status: "ready"; jobs: Job[] }
    | { status: "error" }

interface Props {
    endpoint: string
    applyLabel: string
    emptyText: string
    errorText: string
    maxJobs: number
    showSummary: boolean
    style?: React.CSSProperties
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function JobsFallback(props: Props) {
    const { endpoint, applyLabel, emptyText, errorText, maxJobs, showSummary } = props
    const [state, setState] = useState<State>({ status: "loading" })
    const url = endpointUrl(endpoint)

    useEffect(() => {
        if (!url) return
        const controller = new AbortController()
        setState({ status: "loading" })
        fetch(url, { signal: controller.signal, credentials: "omit" })
            .then((res) => {
                if (!res.ok) throw new Error(String(res.status))
                return res.json()
            })
            .then((body: unknown) => setState({ status: "ready", jobs: readJobs(body) }))
            .catch(() => {
                if (!controller.signal.aborted) setState({ status: "error" })
            })
        return () => controller.abort()
    }, [url])

    if (!url) {
        // Shown in the editor only, so the empty slot is visible while laying out.
        return RenderTarget.current() === RenderTarget.canvas ? (
            <div style={{ ...props.style, ...styles.note }}>Jobs fallback is off. Set Endpoint to switch it on.</div>
        ) : null
    }

    if (state.status === "loading") return <div style={props.style} aria-busy="true" />
    if (state.status === "error") return <p style={{ ...props.style, ...styles.message }}>{errorText}</p>

    const jobs = state.jobs.slice(0, Math.max(1, maxJobs))
    if (jobs.length === 0) return <p style={{ ...props.style, ...styles.message }}>{emptyText}</p>

    return (
        <ul style={{ ...props.style, ...styles.list }}>
            {jobs.map((job) => (
                <li key={job.id} style={styles.item}>
                    <h3 style={styles.title}>{job.title}</h3>
                    {meta(job) && <p style={styles.meta}>{meta(job)}</p>}
                    {showSummary && job.summary && <p style={styles.summary}>{job.summary}</p>}
                    <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" style={styles.apply}>
                        {applyLabel}
                    </a>
                </li>
            ))}
        </ul>
    )
}

// http(s) only, so a mistyped control value cannot become a script URL.
function endpointUrl(value: string): string | null {
    try {
        const url = new URL(value.trim())
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
    } catch {
        return null
    }
}

function httpUrl(value: unknown): string | null {
    return typeof value === "string" ? endpointUrl(value) : null
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}

// Trusts nothing about the response shape: a job without a title or a safe
// apply link is skipped.
function readJobs(body: unknown): Job[] {
    const list = body && typeof body === "object" ? (body as { jobs?: unknown }).jobs : undefined
    if (!Array.isArray(list)) return []
    const jobs: Job[] = []
    for (const item of list) {
        if (!item || typeof item !== "object") continue
        const job = item as Record<string, unknown>
        const id = str(job.id)
        const title = str(job.title)
        const applyUrl = httpUrl(job.applyUrl)
        if (!id || !title || !applyUrl) continue
        jobs.push({
            id,
            title,
            summary: str(job.summary) ?? "",
            location: str(job.location),
            workType: str(job.workType),
            featured: job.featured === true,
            applyUrl,
        })
    }
    // Featured ads first, otherwise feed order.
    return [...jobs.filter((j) => j.featured), ...jobs.filter((j) => !j.featured)]
}

function meta(job: Job): string {
    return [job.location, job.workType].filter(Boolean).join(" | ")
}

const styles: Record<string, React.CSSProperties> = {
    list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 24 },
    item: { display: "flex", flexDirection: "column", gap: 8 },
    title: { margin: 0, font: "inherit", fontWeight: 600, fontSize: "1.25em" },
    meta: { margin: 0, opacity: 0.7 },
    summary: { margin: 0 },
    apply: { color: "inherit", fontWeight: 600 },
    message: { margin: 0 },
    note: { padding: 16, border: "1px dashed currentColor", opacity: 0.6, fontSize: 14 },
}

JobsFallback.defaultProps = {
    endpoint: "",
    applyLabel: "Apply now",
    emptyText: "There are no open roles right now.",
    errorText: "Our current roles could not be loaded. Please try again later.",
    maxJobs: 50,
    showSummary: true,
}

addPropertyControls(JobsFallback, {
    endpoint: {
        type: ControlType.String,
        title: "Endpoint",
        placeholder: "https://<feed host>/jobs.json",
        description: "Empty means off. The Worker must also have JOBS_FALLBACK set to on.",
    },
    applyLabel: { type: ControlType.String, title: "Apply label" },
    emptyText: { type: ControlType.String, title: "No jobs text", displayTextArea: true },
    errorText: { type: ControlType.String, title: "Error text", displayTextArea: true },
    maxJobs: { type: ControlType.Number, title: "Max jobs", min: 1, max: 200, step: 1, displayStepper: true },
    showSummary: { type: ControlType.Boolean, title: "Summary" },
})
