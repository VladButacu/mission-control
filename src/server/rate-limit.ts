import { rateLimit } from "express-rate-limit";

/**
 * Builds a per-route request limiter: `limit` requests per IP per minute, with
 * draft-8 RateLimit headers and a 429 once exceeded.
 *
 * Each call returns a NEW instance with its own in-memory store, so routers
 * built by one createServer() never share counts with another app (tests
 * included). Call it inside a router factory, never at module scope.
 *
 * shortcut: in-memory store and per-IP keys, single process only; move to a
 * shared store before running more than one server process.
 */
export function createRouteRateLimiter(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    statusCode: 429
  });
}
