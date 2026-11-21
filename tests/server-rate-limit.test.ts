import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.ts";
import { createRouteRateLimiter } from "../src/server/rate-limit.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

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

describe("rate-limited CodeQL sinks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rate-limit-routes-"));
    await ensureHarnessRepository(root);
  });

  afterEach(() => {
    void rm(root, { recursive: true, force: true });
  });

  // Each sink answers with its own limiter before the handler runs, so the
  // draft-8 policy header carries the configured limit. The requests stay
  // below the limit and fail inside the handler (no token, unknown ids).
  it.each<[string, (app: express.Express) => request.Test, number]>([
    ["POST /api/shutdown", (app) => request(app).post("/api/shutdown"), 60],
    ["GET /api/attachments/:id", (app) => request(app).get("/api/attachments/missing"), 60],
    ["GET /api/runs/:runId/tail", (app) => request(app).get("/api/runs/run-1/tail"), 600],
    ["GET /api/runs/:runId/artifacts/:fileName", (app) => request(app).get("/api/runs/run-1/artifacts/out.txt"), 60],
    ["GET /api/kernel/:section", (app) => request(app).get("/api/kernel/missing"), 60],
    ["DELETE /api/workflows/:id", (app) => request(app).delete("/api/workflows/missing"), 60]
  ])("%s is limited to %i requests per minute", async (_name, send, limit) => {
    const app = createServer({ root, testMode: true });

    const res = await send(app);

    expect(res.headers["ratelimit-policy"]).toContain(`q=${limit}; w=60`);
  });
});
