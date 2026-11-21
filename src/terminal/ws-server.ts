import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { checkHost, checkOrigin } from "../server/host-guard.ts";
import { parseClientMessage, type TerminalServerMessage } from "./protocol.ts";
import type { SessionManager } from "./session-manager.ts";

const WS_PATH = "/api/terminal/ws";

export interface AttachTerminalOptions {
  manager: SessionManager;
}

function sessionIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname !== WS_PATH) return null;
    const id = parsed.searchParams.get("sessionId");
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

/**
 * Attach a terminal WebSocket server to the existing HTTP server.
 * Path: `/api/terminal/ws?sessionId=<id>`
 */
export function attachTerminalWebSocketServer(
  server: HttpServer,
  options: AttachTerminalOptions
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith(WS_PATH)) return;

    // Host-rebinding and cross-site guard runs before the session lookup. Origin
    // is checked only when the browser sends one (non-browser clients omit it).
    const hostVerdict = checkHost(req.headers.host);
    const verdict = hostVerdict.allowed
      ? checkOrigin(req.headers.origin, req.headers.host)
      : hostVerdict;
    if (!verdict.allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = sessionIdFromUrl(url);
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const session = options.manager.get(sessionId);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sessionId);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, sessionId: string) => {
    const info = options.manager.get(sessionId);
    if (!info) {
      send(ws, { type: "error", message: "Session not found" });
      ws.close();
      return;
    }

    send(ws, {
      type: "ready",
      cols: info.cols,
      rows: info.rows,
      sessionId: info.id
    });

    const unsubscribe = options.manager.subscribe(sessionId, (msg) => {
      send(ws, msg);
    });

    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const msg = parseClientMessage(text);
      if (!msg) return;
      try {
        if (msg.type === "input") {
          options.manager.write(sessionId, msg.data);
        } else if (msg.type === "resize") {
          options.manager.resize(sessionId, msg.cols, msg.rows);
        } else if (msg.type === "ping") {
          send(ws, { type: "pong" });
        }
      } catch (err) {
        send(ws, {
          type: "error",
          message: err instanceof Error ? err.message : String(err)
        });
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });
  });

  return wss;
}
