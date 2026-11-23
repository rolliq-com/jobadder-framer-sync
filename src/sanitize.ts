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
  return rebuildTags(out).trim();
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
