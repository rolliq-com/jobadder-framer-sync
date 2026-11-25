// Cleans a job description's HTML down to an allow-list before it reaches the
// site. Uses the Workers HTMLRewriter (a real HTML parser), not regular
// expressions.

// Kept, with every attribute removed except a safe href on links.
const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "h2", "h3", "h4", "a", "blockquote"]);

// Removed together with everything inside them. Every element the parser
// reads as raw text (script, style, xmp, iframe, noembed, noframes, noscript,
// plaintext) or escapable raw text (textarea, title) must be here: unwrapping
// one would emit its content verbatim, so a tag inside it would come out live.
const DROPPED = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "noscript", "template",
  "xmp", "noembed", "noframes", "plaintext",
  "svg", "math", "head", "title", "form", "input", "button", "select", "textarea", "link", "meta", "base",
]);

// Any other element (div, span, html, body, img, h1, table...) is unwrapped:
// the element goes, its text stays.

export async function sanitizeHtml(html: string): Promise<string> {
  if (!html.trim()) return "";
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROPPED.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        const href = tag === "a" ? safeHref(el.getAttribute("href")) : undefined;
        for (const [name] of [...el.attributes]) if (name) el.removeAttribute(name);
        if (tag === "a") {
          if (!href) {
            el.removeAndKeepContent();
            return;
          }
          el.setAttribute("href", href);
          el.setAttribute("rel", "nofollow noopener noreferrer");
        }
      },
    })
    .onDocument({
      comments(comment) {
        comment.remove();
      },
      doctype() {},
    });
  const out = await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  return normalizeWhitespace(rebuildTags(out));
}

// Whitespace the old site collapsed but the new site's rich text renders:
// it keeps spaces and line breaks as written, so "Lead in:   <br> <ul>"
// shows trailing spaces and a blank line before the list. Runs on the
// rebuilt output, where every tag is a bare allowed tag (or a link with
// exactly the href and rel set above), so matching tags by pattern is safe.
// Only whitespace and line breaks are removed; the words are unchanged.

// An ordinary space, a tab or newline, or a non-breaking space in any spelling.
const SPACE = String.raw`(?:[ \t\r\n\f ]|&nbsp;|&#160;|&#[xX]0*[aA]0;)`;
const BLOCK = String.raw`(?:</?(?:p|ul|ol|li|h2|h3|h4|blockquote)>)`;
const INLINE_OPEN = String.raw`(?:<(?:strong|b|em|i|u)>|<a [^<>]*>)`;
const INLINE_CLOSE = String.raw`(?:</(?:strong|b|em|i|u|a)>)`;

const RULES: [RegExp, string][] = [
  // Space before a line break or a block edge, even with inline end tags between.
  [new RegExp(`${SPACE}+((?:${INLINE_CLOSE})*)(<br>|${BLOCK}|$)`, "g"), "$1$2"],
  // Space after a line break or a block edge, even with inline start tags between.
  [new RegExp(`(^|<br>|${BLOCK})((?:${INLINE_OPEN})*)${SPACE}+`, "g"), "$1$2"],
  // A line break against a block edge, or at the very start or end, adds an empty line.
  [new RegExp(`(^|${BLOCK})((?:${INLINE_OPEN}|${INLINE_CLOSE})*)<br>`, "g"), "$1$2"],
  [new RegExp(`<br>((?:${INLINE_OPEN}|${INLINE_CLOSE})*)(${BLOCK}|$)`, "g"), "$1$2"],
  // More than two line breaks in a row: keep one blank line.
  [/<br><br>(?:<br>)+/g, "<br><br>"],
  // A paragraph left empty.
  [/<p><\/p>/g, ""],
];

/** Removes whitespace and line breaks that would render as extra space. Idempotent. */
export function normalizeWhitespace(html: string): string {
  // Runs of ordinary whitespace in text read as one space, as on the old site.
  // So does a run mixing non-breaking and ordinary spaces (a double space
  // after a full stop); a non-breaking space on its own is kept.
  let out = html
    .replace(/[ \t\r\n\f]+/g, " ")
    .replace(new RegExp(`${SPACE}{2,}`, "g"), (run) => (run.includes(" ") ? " " : run));
  for (let previous = ""; previous !== out; ) {
    previous = out;
    for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  }
  return out;
}

const LINK_ATTRIBUTES = /^ href="[^"<>]*" rel="nofollow noopener noreferrer"$/;

// The rewriter passes some markup through verbatim: an end tag with no
// matching start tag (a stray "</script>"), an end tag carrying attributes,
// and a tag left unclosed at the end of the input ("<img onerror=x//"),
// which turns live as soon as the site puts any markup after it. So every
// tag in the output is rebuilt from its name: an allowed tag is written
// bare (a link keeps only the href and rel set above), a stray end tag is
// removed, and any other "<" is escaped as text.
function rebuildTags(html: string): string {
  return html.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>]*)>|</g, (match, slash: string, name: string | undefined, rest: string) => {
    if (name === undefined) return "&lt;";
    const tag = name.toLowerCase();
    if (slash) return ALLOWED.has(tag) ? `</${tag}>` : "";
    if (!ALLOWED.has(tag)) return `&lt;${match.slice(1)}`;
    if (tag === "a") return LINK_ATTRIBUTES.test(rest) ? `<a${rest}>` : "";
    return `<${tag}>`;
  });
}

// http and https only: no javascript:, data:, or mailto: (an address may name a person).
function safeHref(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Escapes text for use inside HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
