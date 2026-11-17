/** The session cookie: parsing, issuing and clearing it. */
import type { FastifyRequest } from "fastify";

export const SESSION_COOKIE = "lg_home_session";

/** Minimal cookie header parser (no extra dependency needed). */
export function parseCookies(header: string | undefined): Record<string, string> {
  // Null prototype: a cookie named "__proto__" or "constructor" is just a key.
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    out[name] = safeDecode(part.slice(eq + 1).trim());
  }
  return out;
}

/** Cookie values come from the client: malformed %-escapes must not throw. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return cookieHeader(token, { maxAge, secure });
}

export function clearedSessionCookie(secure: boolean): string {
  return cookieHeader("", { maxAge: 0, secure });
}

function cookieHeader(value: string, { maxAge, secure }: { maxAge: number; secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Whether the session cookie gets `Secure`: `cookieSecure` (COOKIE_SECURE, see
 * config.ts) forces it on or off; null detects HTTPS from the request.
 */
export function isSecureRequest(req: FastifyRequest, cookieSecure: boolean | null = null): boolean {
  return cookieSecure ?? req.protocol === "https";
}

export function sessionTokenOf(req: FastifyRequest): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}
