import { ObjectId } from "mongodb";
import { config } from "../config";
import {
  getEmailFollowUpsCollection,
} from "../db/mongo";
import { extractTrackingTag } from "../utils/trackingTag";
import {
  EmailFollowUpDocument,
  ReplyMatchMethod,
} from "../db/schema";

export interface MatchInput {
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  fromEmail: string;
  inReplyTo: string | null;
  references: string | null;
}

export interface MatchResult {
  followUpId: ObjectId | null;
  method: ReplyMatchMethod;
}

/**
 * Tries the four strategies from the plan in order. First hit wins. If nothing
 * matches, returns { followUpId: null, method: "unmatched" } and the caller
 * still persists the reply (we never drop inbound data).
 */
export async function matchReplyToFollowUp(input: MatchInput): Promise<MatchResult> {
  const followUps = getEmailFollowUpsCollection();

  // Strategy 1 — plus-addressed To/Cc, e.g. "dev+followup-<tag>@moviant.ai".
  // Reserved for the future programmatic-send path; the parser is live now so
  // we get a hit the moment we flip to programmatic.
  const plusTag = findPlusAddressTag([...input.toEmails, ...input.ccEmails]);
  if (plusTag) {
    const fu = await followUps.findOne({ trackingTag: plusTag });
    if (fu) return { followUpId: fu._id!, method: "plus_address" };
  }

  // Strategy 2 — In-Reply-To / References match outboundMessageId. Only useful
  // once we send programmatically and store the outbound Message-ID.
  const headerIds = [
    ...(input.inReplyTo ? splitMessageIds(input.inReplyTo) : []),
    ...(input.references ? splitMessageIds(input.references) : []),
  ];
  if (headerIds.length > 0) {
    const fu = await followUps.findOne({
      outboundMessageId: { $in: headerIds },
    });
    if (fu) return { followUpId: fu._id!, method: "in_reply_to" };
  }

  // Strategy 3 — subject tag [FU-<tag>]. Primary path for the POC.
  const tag = extractTrackingTag(input.subject);
  if (tag) {
    const fu = await followUps.findOne({ trackingTag: tag });
    if (fu) return { followUpId: fu._id!, method: "subject_tag" };
  }

  // Strategy 4 — from-address heuristic. If exactly one follow-up was sent to
  // this address in the last 30 days, match it. Zero or multiple → punt.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const candidates = await followUps
    .find({
      toEmail: input.fromEmail.toLowerCase(),
      sentAt: { $ne: null, $gte: since },
    })
    .sort({ sentAt: -1 })
    .limit(2)
    .toArray();
  if (candidates.length === 1) {
    return { followUpId: candidates[0]._id!, method: "from_address_heuristic" };
  }
  // Try case-insensitive on toEmail too — addresses are case-insensitive in practice.
  if (candidates.length === 0) {
    const ci = await followUps
      .find({
        toEmail: { $regex: `^${escapeRegex(input.fromEmail)}$`, $options: "i" },
        sentAt: { $ne: null, $gte: since },
      })
      .sort({ sentAt: -1 })
      .limit(2)
      .toArray();
    if (ci.length === 1) {
      return { followUpId: ci[0]._id!, method: "from_address_heuristic" };
    }
  }

  return { followUpId: null, method: "unmatched" };
}

const PLUS_ADDRESS_REGEX_BASE = /\+followup-([a-z0-9-]+)@/i;

function findPlusAddressTag(addresses: string[]): string | null {
  const expectedDomain = config.emailFollowUps.replyToDomain.toLowerCase();
  const expectedLocal = config.emailFollowUps.replyToLocalPart.toLowerCase();
  for (const raw of addresses) {
    if (!raw) continue;
    const addr = extractEmailAddress(raw).toLowerCase();
    if (!addr.startsWith(`${expectedLocal}+`)) continue;
    if (!addr.endsWith(`@${expectedDomain}`)) continue;
    const m = addr.match(PLUS_ADDRESS_REGEX_BASE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Pulls the bare address out of a header value that may include a display name,
 * angle brackets, or extra whitespace: "Foo Bar <foo@bar.com>" → "foo@bar.com".
 */
export function extractEmailAddress(input: string): string {
  if (!input) return "";
  const angle = input.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  return input.trim();
}

function splitMessageIds(value: string): string[] {
  // Headers like "<id1@host>" or "<id1> <id2>" or comma-separated.
  return value
    .split(/[\s,]+/)
    .map((s) => s.replace(/^[<]+|[>]+$/g, "").trim())
    .filter(Boolean);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type FollowUpForMatch = EmailFollowUpDocument;
