import { isIP } from "node:net";

/**
 * Host and Origin rules for the local API and the terminal WebSocket.
 * Pure functions over header strings: no Express or ws types here.
 *
 * Host: loopback names only (localhost, *.localhost, 127.0.0.0/8, ::1). Every
 * other name or IP literal is denied, which blocks DNS rebinding and requests
 * addressed to other interfaces. The port is ignored.
 *
 * Origin: a missing Origin is allowed (curl, the CLI). "null" and unparseable
 * Origins are denied. Otherwise the Origin hostname must equal the Host
 * hostname, or pass the Host rule.
 */

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: GuardVerdict = { allowed: true };
const DENY_HOST: GuardVerdict = { allowed: false, reason: "Request Host header is not allowed." };
const DENY_ORIGIN: GuardVerdict = { allowed: false, reason: "Request Origin is not allowed." };

/**
 * Hostname from a Host header or a URL host: strips the port, IPv6 brackets,
 * case and one trailing dot. Returns "" when nothing usable remains.
 */
function normalizeHostname(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? "" : host.slice(1, end);
  } else if (host.split(":").length === 2) {
    host = host.slice(0, host.indexOf(":"));
  }
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function isLoopbackName(name: string): boolean {
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1") return true;
  return isIP(name) === 4 && name.startsWith("127.");
}

export function checkHost(hostHeader: string | undefined): GuardVerdict {
  if (hostHeader === undefined) return DENY_HOST;
  return isLoopbackName(normalizeHostname(hostHeader)) ? ALLOWED : DENY_HOST;
}

export function checkOrigin(origin: string | undefined, hostHeader: string | undefined): GuardVerdict {
  if (origin === undefined) return ALLOWED;
  if (origin === "null") return DENY_ORIGIN;

  let originName: string;
  try {
    originName = normalizeHostname(new URL(origin).host);
  } catch {
    return DENY_ORIGIN;
  }
  if (originName === "") return DENY_ORIGIN;

  const hostName = hostHeader === undefined ? "" : normalizeHostname(hostHeader);
  if (originName === hostName) return ALLOWED;
  return isLoopbackName(originName) ? ALLOWED : DENY_ORIGIN;
}

export interface GuardRequest {
  method: string;
  host: string | undefined;
  origin: string | undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host always; Origin for state-changing methods only. */
export function checkRequest(req: GuardRequest): GuardVerdict {
  const host = checkHost(req.host);
  if (!host.allowed) return host;
  if (SAFE_METHODS.has(req.method)) return ALLOWED;
  return checkOrigin(req.origin, req.host);
}
