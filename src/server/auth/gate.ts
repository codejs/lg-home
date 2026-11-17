/** The session check in front of every protected `/api` route. */
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { sessionTokenOf } from "./cookies.js";
import { getSessionUser, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, set by the auth gate for protected API routes. */
    user?: SessionUser;
  }
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
