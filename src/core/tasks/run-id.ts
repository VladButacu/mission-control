import { EntityNotFoundError } from "./errors.ts";

/** Canonical lowercase UUID, the form crypto.randomUUID() produces for every stored run. */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/**
 * Validate a run id from outside input. A value that is not a canonical UUID cannot name a
 * stored run, so it is reported as the same not-found error an absent run gets.
 */
export function parseRunId(value: unknown): string {
  if (!isRunId(value)) {
    throw new EntityNotFoundError("run", String(value));
  }
  return value;
}
