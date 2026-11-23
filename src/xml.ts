import { XMLParser, XMLValidator } from "fast-xml-parser";

export type XmlResult =
  | { ok: true; root: string }
  | { ok: false; reason: "not_utf8" | "doctype_not_allowed" | "malformed_xml" };

export const MAX_ROOT_NAME_LENGTH = 100;

// Used only to find the top-level elements. Entities are not expanded.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

// Checks that the payload is well-formed UTF-8 XML with exactly one root
// element, and returns that element's name. The root is reported, not
// enforced, so a payload of an unexpected shape is still captured and can be
// diagnosed.
export function checkXml(bytes: Uint8Array): XmlResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }

  // The feed never needs a DTD. Refusing one rules out entity expansion
  // attacks on anything that parses the stored payload later.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, reason: "doctype_not_allowed" };

  if (XMLValidator.validate(text) !== true) return { ok: false, reason: "malformed_xml" };

  // The validator allows several top-level elements; XML allows one.
  let nodes: Record<string, unknown>[];
  try {
    nodes = parser.parse(text);
  } catch {
    return { ok: false, reason: "malformed_xml" };
  }
  const roots = nodes.flatMap((node) => Object.keys(node).filter((k) => k !== "#text"));
  if (roots.length !== 1) return { ok: false, reason: "malformed_xml" };
  // Capped so the name always fits in KV metadata (1024 bytes in all): an
  // overlong one would fail every write and the sender would retry forever.
  return { ok: true, root: roots[0]!.slice(0, MAX_ROOT_NAME_LENGTH) };
}
