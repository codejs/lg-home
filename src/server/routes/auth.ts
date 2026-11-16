import type { FastifyInstance } from "fastify";
import {
  MAX_PASSWORD_LENGTH,
  authenticate,
  clearedSessionCookie,
  createSession,
  deleteSession,
  getSessionUser,
  isSecureRequest,
  sessionCookie,
  sessionTokenOf,
} from "../auth.js";
import { LoginThrottle } from "../login-throttle.js";

interface LoginBody {
  username: string;
  password: string;
}

export interface AuthRoutesOptions {
  /** Brute-force brake; each registration gets its own unless one is passed in. */
  throttle?: LoginThrottle;
}

/** Generic on purpose: never reveal whether the username or the password was wrong. */
export const INVALID_CREDENTIALS = "Invalid username or password";

const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", minLength: 1, maxLength: 128 },
      password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
    },
    additionalProperties: false,
  },
} as const;

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions = {}) {
  const throttle = options.throttle ?? new LoginThrottle();

  /** Who am I? The SPA calls this first to decide between login page and app. */
  app.get("/api/auth/me", async (req, reply) => {
    const user = getSessionUser(sessionTokenOf(req));
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    return { user };
  });

  /** Exchange credentials for a session cookie. */
  app.post<{ Body: LoginBody }>("/api/auth/login", { schema: loginSchema }, async (req, reply) => {
    const { username, password } = req.body;
    const key = throttle.key(req.ip, username);

    if (throttle.isBlocked(key)) {
      req.log.warn({ ip: req.ip, username }, "login blocked: too many attempts");
      return reply.code(429).send({ error: "Too many failed attempts. Try again later." });
    }

    const user = await authenticate(username, password);
    if (!user) {
      throttle.recordFailure(key);
      req.log.warn({ ip: req.ip, username }, "login failed");
      return reply.code(401).send({ error: INVALID_CREDENTIALS });
    }

    throttle.reset(key);
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
