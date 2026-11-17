/** Login sessions: stored as token hashes, expiring after the configured lifetime (see config.ts). */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { User } from "../../shared/api.js";
import { db, schema } from "../db/index.js";

/** How long a login stays valid unless configured otherwise: 7 days. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The signed-in user, as the API reports it. */
export type SessionUser = User;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session for a user, valid for `ttlMs`, and return the opaque cookie token. */
export function createSession(userId: number, ttlMs = DEFAULT_SESSION_TTL_MS): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
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
