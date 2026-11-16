import { eq } from "drizzle-orm";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, deleteUserSessions, hashPassword, normalizeUsername } from "./auth.js";
import { db, schema } from "./db/index.js";

/** A problem with operator input (bad username/password, duplicate user). */
export class UserInputError extends Error {
  override name = "UserInputError";
}

const USERNAME_PATTERN = /^[a-z0-9._@-]{3,64}$/;

/** Normalise and validate a username; returns the stored form. */
export function validateUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserInputError("Username must be 3-64 characters: letters, digits, dot, dash, underscore or @.");
  }
  return username;
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserInputError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new UserInputError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  // Control characters can't be typed into the login form, and trailing NULs
  // would be indistinguishable from their absence (HMAC zero-padding).
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    throw new UserInputError("Password must not contain control characters.");
  }
}

export interface ProvisionResult {
  username: string;
  created: boolean;
}

/**
 * Create a user, or with `force` reset an existing user's password (which also
 * signs them out everywhere). Validation happens before anything is written.
 */
export async function provisionUser(input: { username: string; password: string; force?: boolean }): Promise<ProvisionResult> {
  const username = validateUsername(input.username);
  validatePassword(input.password);

  const existing = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing && !input.force) {
    throw new UserInputError(`User "${username}" already exists. Re-run with --force to change the password.`);
  }

  const now = new Date();
  const passwordHash = await hashPassword(input.password);
  if (existing) {
    db.update(schema.users).set({ passwordHash, updatedAt: now }).where(eq(schema.users.id, existing.id)).run();
    deleteUserSessions(existing.id);
    return { username, created: false };
  }
  db.insert(schema.users).values({ username, passwordHash, createdAt: now, updatedAt: now }).run();
  return { username, created: true };
}
