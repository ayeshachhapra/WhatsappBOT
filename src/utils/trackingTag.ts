import { randomBytes } from "crypto";

/**
 * Short opaque tag embedded in subject lines as `[FU-<tag>]`. 8 hex chars =
 * 4 bytes of entropy, ~4.3 billion values — plenty for a single-user POC and
 * the unique index will catch the astronomically-unlikely collision.
 */
export function generateTrackingTag(): string {
  return randomBytes(4).toString("hex");
}

const SUBJECT_TAG_REGEX = /\[FU-([a-f0-9]+)\]/i;

export function extractTrackingTag(subject: string): string | null {
  const m = subject.match(SUBJECT_TAG_REGEX);
  return m ? m[1].toLowerCase() : null;
}

export function appendTrackingTag(subject: string, tag: string): string {
  const trimmed = subject.trim();
  return trimmed ? `${trimmed} [FU-${tag}]` : `[FU-${tag}]`;
}
