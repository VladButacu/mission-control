/**
 * Pieces that try to climb out of a base path or hide a traversal from a naive check:
 * dot segments, separators, NUL, percent-encoded dots and slashes, and long segments.
 * Property tests combine these into hostile inputs for path and slug normalizers.
 */
export const HOSTILE_PIECES = [
  "..",
  ".",
  "/",
  "\\",
  "\0",
  "%2e",
  "%2E%2e",
  "%2f",
  "%5c",
  "a".repeat(300),
  "x",
  "-",
  "_",
  " "
];
