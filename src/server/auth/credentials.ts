/** Checking a username/password pair against the users table. */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { verifyDummyPassword, verifyPassword } from "./passwords.js";
import type { SessionUser } from "./sessions.js";

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
    await verifyDummyPassword(password);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, username: user.username };
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
