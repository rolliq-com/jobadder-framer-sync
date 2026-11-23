export type BodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "empty" | "unreadable" };

// Reads the request body, stopping as soon as it passes maxBytes. The
// Content-Length header is checked first but not trusted: the running count
// enforces the cap even when the header is absent or wrong.
export async function readCappedBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: false, reason: "empty" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (total === 0) return { ok: false, reason: "empty" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
