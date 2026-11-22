import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.ts";
import { checkHost } from "../src/server/host-guard.ts";
import { attachTerminalWebSocketServer } from "../src/terminal/ws-server.ts";
import {
  createSessionManager,
  type PtyHandle,
  type PtySpawnOptions,
  type SessionManager
} from "../src/terminal/session-manager.ts";

function fakeSpawn(_opts: PtySpawnOptions): PtyHandle {
  return {
    pid: 1,
    cols: 80,
    rows: 24,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit() {}
  };
}

describe("Host and Origin guard on the HTTP API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-host-guard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a rebinding Host on a GET", async () => {
    const app = createServer({ root, testMode: true });
    const res = await request(app).get("/api/nope").set("Host", "evil.example").expect(403);
    expect(res.body).toEqual({ error: "Request Host header is not allowed." });
  });

  it("rejects a rebinding Host on the SSE stream", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).get("/api/events").set("Host", "evil.example").expect(403);
  });

  it("rejects a request with no Host header", () => {
    expect(checkHost(undefined).allowed).toBe(false);
  });

  it.each(["localhost:4827", "127.0.0.1:4827", "127.0.0.2:4827", "[::1]:4827", "LOCALHOST.:5173", "app.localhost:4827"])(
    "accepts loopback Host %s",
    async (host) => {
      const app = createServer({ root, testMode: true });
      await request(app).get("/api/nope").set("Host", host).expect(404);
    }
  );

  it.each(["192.168.1.20:4827", "10.0.0.5:4827", "mac.lan:4827", "0.0.0.0:4827"])(
    "rejects non-loopback Host %s",
    async (host) => {
      const app = createServer({ root, testMode: true });
      await request(app).get("/api/nope").set("Host", host).expect(403);
    }
  );

  it("accepts a same-origin POST", async () => {
    const app = createServer({ root, testMode: true });
    await request(app)
      .post("/api/nope")
      .set("Host", "127.0.0.1:4827")
      .set("Origin", "http://127.0.0.1:4827")
      .expect(404);
  });

  it("rejects a cross-site POST", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/nope").set("Origin", "https://evil.example").expect(403);
  });

  it("rejects an Origin of null", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/nope").set("Origin", "null").expect(403);
  });

  it("rejects an unparseable Origin", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/nope").set("Origin", "not a url").expect(403);
  });

  it("rejects a LAN IP Origin on a loopback Host", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/nope").set("Origin", "http://192.168.1.20:4827").expect(403);
  });

  it("accepts a POST with no Origin", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/nope").expect(404);
  });

  it("accepts an allowlisted loopback Origin, such as the Vite dev proxy", async () => {
    const app = createServer({ root, testMode: true });
    await request(app)
      .post("/api/nope")
      .set("Host", "127.0.0.1:4827")
      .set("Origin", "http://localhost:5173")
      .expect(404);
  });

  it("does not check Origin on GET", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).get("/api/nope").set("Origin", "https://evil.example").expect(404);
  });
});

describe("Host and Origin guard on the terminal WebSocket upgrade", () => {
  let manager: SessionManager;
  let server: http.Server;
  let sessionId: string;
  let port: number;

  beforeEach(async () => {
    manager = createSessionManager({ spawn: fakeSpawn });
    sessionId = manager.create({ command: "sh", args: [], cwd: tmpdir(), env: {} }).id;
    server = http.createServer();
    attachTerminalWebSocketServer(server, { manager });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function wsUrl(): string {
    return `ws://127.0.0.1:${port}/api/terminal/ws?sessionId=${sessionId}`;
  }

  /** Resolves with the HTTP status the upgrade was refused with, or 101 when accepted. */
  function upgradeStatus(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(), { headers });
      ws.once("open", () => {
        ws.close();
        resolve(101);
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once("error", reject);
    });
  }

  it("rejects an upgrade with a rebinding Host", async () => {
    expect(await upgradeStatus({ Host: "evil.example" })).toBe(403);
  });

  it("rejects an upgrade with a LAN Host", async () => {
    expect(await upgradeStatus({ Host: "192.168.1.20:4827" })).toBe(403);
  });

  it("rejects an upgrade with a cross-site Origin", async () => {
    expect(await upgradeStatus({ Origin: "https://evil.example" })).toBe(403);
  });

  it("accepts a same-origin upgrade", async () => {
    expect(await upgradeStatus({ Origin: `http://127.0.0.1:${port}` })).toBe(101);
  });

  it("accepts an upgrade with no Origin", async () => {
    expect(await upgradeStatus({})).toBe(101);
  });
});
