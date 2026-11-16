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

const DEFAULT_SESSION_TTL_HOURS = 24 * 7;
const MAX_SESSION_TTL_HOURS = 24 * 366;

/**
 * Session lifetime from SESSION_TTL_HOURS (default 7 days). Invalid values fail
 * loudly: silently producing NaN or a past expiry would break every login.
 */
export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SESSION_TTL_HOURS?.trim();
  if (!raw) return DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SESSION_TTL_HOURS) {
    throw new Error(`SESSION_TTL_HOURS must be a number of hours between 0 and ${MAX_SESSION_TTL_HOURS} (got "${raw}")`);
  }
  return Math.round(hours * 60 * 60 * 1000);
}

/** How long a login stays valid, in milliseconds. */
export const SESSION_TTL_MS = sessionTtlMs();

export const MIN_PASSWORD_LENGTH = 8;
/** Upper bound shared by the login endpoint and add_user, so every password set can also be used. */
export const MAX_PASSWORD_LENGTH = 1024;

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

/** Digests shorter than this are treated as corrupt (an empty digest would match anything). */
const MIN_DIGEST_LENGTH = 16;

/** Parse a stored digest; null when malformed or its cost parameters are out of bounds. */
function parseDigest(stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Bounds keep a tampered row from turning a login into a CPU/memory bomb.
  const isPowerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!isPowerOfTwo || !Number.isInteger(R) || R < 1 || R > 32 || !Number.isInteger(P) || P < 1 || P > 16) {
    return null;
  }
  const salt = Buffer.from(saltB64, "base64");
  const hash = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || hash.length < MIN_DIGEST_LENGTH) return null;
  return { N, r: R, p: P, salt, hash };
}

/** Constant-time check of a password against a stored digest. Malformed digests never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const digest = parseDigest(stored);
  if (!digest) return false;
  try {
    const actual = await scrypt(password.normalize("NFKC"), digest.salt, digest.hash.length, {
      N: digest.N,
      r: digest.r,
      p: digest.p,
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(actual, digest.hash);
  } catch {
    return false;
  }
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
