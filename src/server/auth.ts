import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { db, schema } from "./db/index.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, set by the auth gate for protected API routes. */
    user?: SessionUser;
  }
}

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt parameters (~100ms per hash); stored with the digest so they can change later. */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const SESSION_COOKIE = "lg_home_session";
/** How long a login stays valid, in milliseconds (default 7 days). */
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 24 * 7) * 60 * 60 * 1000;

export const MIN_PASSWORD_LENGTH = 8;

export interface SessionUser {
  id: number;
  username: string;
}

/** Hash a password with scrypt: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Constant-time check of a password against a stored digest. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Check a username/password pair. Returns the user on success, null otherwise.
 * Unknown usernames still pay the cost of a hash so responses don't leak which
 * half of the credentials was wrong.
 */
export async function authenticate(username: string, password: string): Promise<SessionUser | null> {
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, normalizeUsername(username)))
    .get();

  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, username: user.username };
}

/** A throwaway digest used to equalise timing for unknown usernames. */
const DUMMY_HASH = [
  "scrypt",
  SCRYPT.N,
  SCRYPT.r,
  SCRYPT.p,
  randomBytes(SALT_LENGTH).toString("base64"),
  randomBytes(KEY_LENGTH).toString("base64"),
].join("$");

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session for a user and return the opaque cookie token. */
export function createSession(userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(schema.sessions).values({ id: tokenHash(token), userId, createdAt: now, expiresAt }).run();
  deleteExpiredSessions();
  return { token, expiresAt };
}

/** Resolve a cookie token to its user, or null when missing/expired. */
export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, tokenHash(token)), gt(schema.sessions.expiresAt, new Date())))
    .get();
  return row ?? null;
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  db.delete(schema.sessions).where(eq(schema.sessions.id, tokenHash(token))).run();
}

export function deleteExpiredSessions(): void {
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).run();
}

/** Drop every session of a user, e.g. after a password change. */
export function deleteUserSessions(userId: number): void {
  db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
}

/** Minimal cookie header parser (no extra dependency needed). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
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

/** Mark the session cookie `Secure` on HTTPS; override with COOKIE_SECURE. */
export function isSecureRequest(req: FastifyRequest): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override) return override === "true" || override === "1";
  return req.protocol === "https";
}

export function sessionTokenOf(req: FastifyRequest): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

/** Endpoints reachable without a session: the login page needs them. */
const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/me"]);

/**
 * Gate for the whole API: every `/api/*` route except the ones above requires a
 * valid session cookie. Static SPA assets stay public - the app itself renders
 * the login page until `/api/auth/me` reports a user.
 */
export const authGate: onRequestAsyncHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  // Prefer the matched route pattern; it is immune to odd URL encodings.
  const path = req.routeOptions?.url ?? req.url.split("?")[0];
  if (!path.startsWith("/api/") || PUBLIC_API_PATHS.has(path)) return;

  const user = getSessionUser(sessionTokenOf(req));
  if (!user) {
    return reply.code(401).send({ error: "Authentication required" });
  }
  req.user = user;
};
