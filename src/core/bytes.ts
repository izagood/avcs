// Byte-level content predicates for the byte-based content model.
// Mirrors git's binary heuristic so the reducer can route binary blobs around merge3.

import { Buffer } from "node:buffer";

// Git scans the first 8000 bytes for a NUL; presence of one ⇒ treat as binary.
const SNIFF_BYTES = 8000;

/**
 * True iff `buf` looks binary: a NUL (0x00) byte within the first 8000 bytes.
 * Matches git's heuristic so text/binary classification stays consistent.
 */
export function isBinary(buf: Buffer): boolean {
  const nul = buf.indexOf(0x00);
  return nul !== -1 && nul < SNIFF_BYTES;
}
