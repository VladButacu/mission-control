import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createRouteRateLimiter } from "../src/server/rate-limit.ts";

function appWithLimit(limit: number): express.Express {
  const app = express();
  app.get("/limited", createRouteRateLimiter(limit), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("createRouteRateLimiter", () => {
  it("passes requests under the limit and answers 429 with draft-8 headers over it", async () => {
    const app = appWithLimit(2);

    const first = await request(app).get("/limited").expect(200);
    expect(first.headers["ratelimit-policy"]).toMatch(/q=2; w=60/);
    expect(first.headers["ratelimit"]).toMatch(/r=1; t=\d+/);

    await request(app).get("/limited").expect(200);

    const over = await request(app).get("/limited").expect(429);
    expect(over.headers["ratelimit"]).toMatch(/r=0; t=\d+/);
    expect(over.headers["ratelimit-policy"]).toMatch(/q=2; w=60/);
    // legacyHeaders is off: no X-RateLimit-* or draft-6 RateLimit-Limit headers.
    expect(over.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(over.headers["ratelimit-limit"]).toBeUndefined();
  });

  it("gives each factory call its own counter", async () => {
    const a = appWithLimit(1);
    const b = appWithLimit(1);

    await request(a).get("/limited").expect(200);
    await request(a).get("/limited").expect(429);

    await request(b).get("/limited").expect(200);
  });
});
