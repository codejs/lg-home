import type { FastifyInstance } from "fastify";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
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
import type { StreamRegistry } from "../events/streams.js";

export interface AuthRoutesOptions {
  /** Brute-force brake; each registration gets its own unless one is passed in. */
  throttle?: LoginThrottle;
  /** How long a login stays valid (SESSION_TTL_HOURS); default 7 days. */
  sessionTtlMs?: number;
  /** Force the cookie's Secure flag on or off (COOKIE_SECURE); null/omitted detects HTTPS. */
  cookieSecure?: boolean | null;
  /** The app's event streams, ended when their session logs out or is replaced. */
  streams?: StreamRegistry;
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

export async function authRoutes(instance: FastifyInstance, options: AuthRoutesOptions = {}) {
  // Request types are derived from the route schemas below.
  const app = instance.withTypeProvider<JsonSchemaToTsProvider>();
  const throttle = options.throttle ?? new LoginThrottle();

  /** Who am I? The SPA calls this first to decide between login page and app. */
  app.get("/api/auth/me", async (req, reply) => {
    const user = getSessionUser(sessionTokenOf(req));
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    return { user };
  });

  /** Exchange credentials for a session cookie. */
  app.post("/api/auth/login", { schema: loginSchema }, async (req, reply) => {
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
    const previous = sessionTokenOf(req);
    deleteSession(previous);
    options.streams?.closeForSession(previous);
    const { token, expiresAt } = createSession(user.id, options.sessionTtlMs);
    reply.header("Set-Cookie", sessionCookie(token, expiresAt, isSecureRequest(req, options.cookieSecure)));
    req.log.info({ userId: user.id, username: user.username }, "login succeeded");
    return { user };
  });

  /** Drop the current session; safe to call when not signed in. */
  app.post("/api/auth/logout", async (req, reply) => {
    const token = sessionTokenOf(req);
    deleteSession(token);
    // Live event streams of this session end now, not at the next heartbeat.
    options.streams?.closeForSession(token);
    reply.header("Set-Cookie", clearedSessionCookie(isSecureRequest(req, options.cookieSecure)));
    return { ok: true };
  });
}
