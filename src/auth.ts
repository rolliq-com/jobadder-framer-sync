import type { AuthConfig } from "./config";

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailure };
export type AuthFailure = "wrong_path" | "no_credentials" | "malformed_credentials" | "bad_credentials";

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

// Compares two strings in time that does not depend on where they differ.
// Both sides are hashed first, so the compared buffers always have equal
// length and the secret's length does not leak either.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export async function authenticate(request: Request, url: URL, auth: AuthConfig): Promise<AuthResult> {
  if (auth.mode === "path") {
    const ok = await constantTimeEqual(url.pathname, `/${auth.secret}`);
    return ok ? { ok: true } : { ok: false, reason: "wrong_path" };
  }

  if (url.pathname !== auth.path) return { ok: false, reason: "wrong_path" };

  const header = request.headers.get("Authorization");
  if (!header) return { ok: false, reason: "no_credentials" };
  const match = /^Basic[ ]+([A-Za-z0-9+/]+={0,2})[ ]*$/i.exec(header);
  if (!match) return { ok: false, reason: "malformed_credentials" };

  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "malformed_credentials" };
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return { ok: false, reason: "malformed_credentials" };

  // Evaluate both comparisons so timing does not reveal which one failed.
  const [userOk, passOk] = await Promise.all([
    constantTimeEqual(decoded.slice(0, sep), auth.user),
    constantTimeEqual(decoded.slice(sep + 1), auth.pass),
  ]);
  return userOk && passOk ? { ok: true } : { ok: false, reason: "bad_credentials" };
}
