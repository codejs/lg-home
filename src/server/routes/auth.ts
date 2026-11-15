import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  authenticate,
  clearedSessionCookie,
  createSession,
  deleteSession,
  getSessionUser,
  isSecureRequest,
  sessionCookie,
  sessionTokenOf,
} from "../auth.js";

interface LoginBody {
  username: string;
  password: string;
}

/** Generic on purpose: never reveal whether the username or the password was wrong. */
const INVALID_CREDENTIALS = "Invalid username or password";

const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", minLength: 1, maxLength: 128 },
      password: { type: "string", minLength: 1, maxLength: 1024 },
    },
    additionalProperties: false,
  },
} as const;

// Simple in-memory brute-force brake: too many failures from one IP/username
// pair parks further attempts for a while. Resets when the process restarts.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

function attemptKey(req: FastifyRequest, username: string): string {
  return `${req.ip}|${username.toLowerCase()}`;
}

function tooManyAttempts(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

export async function authRoutes(app: FastifyInstance) {
  /** Who am I? The SPA calls this first to decide between login page and app. */
  app.get("/api/auth/me", async (req, reply) => {
    const user = getSessionUser(sessionTokenOf(req));
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    return { user };
  });

  /** Exchange credentials for a session cookie. */
  app.post<{ Body: LoginBody }>("/api/auth/login", { schema: loginSchema }, async (req, reply) => {
    const { username, password } = req.body;
    const key = attemptKey(req, username);

    if (tooManyAttempts(key)) {
      req.log.warn({ ip: req.ip, username }, "login blocked: too many attempts");
      return reply.code(429).send({ error: "Too many failed attempts. Try again later." });
    }

    const user = await authenticate(username, password);
    if (!user) {
      recordFailure(key);
      req.log.warn({ ip: req.ip, username }, "login failed");
      return reply.code(401).send({ error: INVALID_CREDENTIALS });
    }

    attempts.delete(key);
    // Drop any cookie the client arrived with, then issue a fresh session.
    deleteSession(sessionTokenOf(req));
    const { token, expiresAt } = createSession(user.id);
    reply.header("Set-Cookie", sessionCookie(token, expiresAt, isSecureRequest(req)));
    req.log.info({ userId: user.id, username: user.username }, "login succeeded");
    return { user };
  });

  /** Drop the current session; safe to call when not signed in. */
  app.post("/api/auth/logout", async (req, reply) => {
    deleteSession(sessionTokenOf(req));
    reply.header("Set-Cookie", clearedSessionCookie(isSecureRequest(req)));
    return { ok: true };
  });
}
