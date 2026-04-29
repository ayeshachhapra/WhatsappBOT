import type { ObjectId } from "mongodb";

export type Sentiment = "positive" | "neutral" | "negative";

export interface MessageDocument {
  _id?: ObjectId;
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  /** True if this message was sent by the connected user (the bot owner) themselves. */
  fromMe: boolean;
  body: string;
  messageType: string;
  /** "text" if the body came from text/caption; "ocr" if it was extracted from an image. */
  bodySource: "text" | "ocr";
  timestamp: Date;
  // AI-enriched (filled by pipeline)
  topic: string | null;
  summary: string | null;
  entities: string[];
  actionItems: string[];
  sentiment: Sentiment | null;
  /** PO numbers, AWBs, invoice IDs, container numbers, tracking IDs etc. mentioned in the message. */
  referenceNumbers: string[];
  /** ETA / promised / scheduled / delivery date if mentioned, else null. ISO string. */
  dueDate: Date | null;
  embedding: number[] | null;
  extractedAt: Date | null;
  createdAt: Date;
}

export interface GroupRef {
  jid: string;
  name: string;
}

/**
 * A WhatsApp @-mention. `jid` must be a phone JID (`<digits>@s.whatsapp.net`).
 * If `name` is provided, the manager will substitute `@<name>` (case-insensitive)
 * tokens in the body with `@<digits>` so the recipient sees an inline mention pill
 * where the name appears.
 */
export interface MentionRef {
  jid: string;
  name?: string;
}

export interface GroupFiltersDocument {
  _id: string; // always "default"
  groups: GroupRef[];
  updatedAt: Date;
}

export type ScheduleMode = "static" | "ai_draft";

export interface ScheduledMessageDocument {
  _id?: ObjectId;
  name: string;
  mode: ScheduleMode;
  messageText: string | null;
  aiPrompt: string | null;
  targetGroups: GroupRef[];
  schedule: {
    times: string[]; // HH:mm
    days: number[]; // 0=Sun..6=Sat; [] = every day
  };
  enabled: boolean;
  autoSend: boolean;
  /**
   * If true, the scheduler auto-disables this schedule the next time it ticks
   * and finds that ANY new message has been received in the targetGroups
   * since the schedule's lastSentAt (or createdAt if never sent).
   * Used by "auto-chase until response" follow-ups created from chat.
   */
  stopOnResponse?: boolean;
  /** Optional WhatsApp JIDs to @-mention in the outbound message (legacy shape). */
  mentionJids?: string[];
  /** Optional rich @-mentions with display names for inline substitution. */
  mentions?: MentionRef[];
  lastSentAt: Date | null;
  lastSendResult: string | null;
  sendCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type DraftStatus = "pending" | "approved" | "rejected" | "sent";

export interface DraftMeta {
  chatQuestion?: string;
  chatAnswerSnippet?: string;
  triggerSender?: string; // person being followed up with, if known
}

export interface DraftDocument {
  _id?: ObjectId;
  scheduleId: ObjectId | null;
  scheduleName: string;
  draftText: string;
  targetGroups: GroupRef[];
  /** Optional WhatsApp JIDs to @-mention when this draft is sent (legacy shape). */
  mentionJids?: string[];
  /** Optional rich @-mentions with display names for inline substitution. */
  mentions?: MentionRef[];
  status: DraftStatus;
  source: "schedule" | "manual";
  meta: DraftMeta | null;
  createdAt: Date;
  decidedAt: Date | null;
  sentAt: Date | null;
  sendError: string | null;
}

export interface SendLogDocument {
  _id?: ObjectId;
  scheduleId: ObjectId | null;
  scheduleName: string;
  draftId: ObjectId | null;
  messageText: string;
  targetGroup: GroupRef;
  status: "success" | "failed";
  error: string | null;
  sentAt: Date;
}

/**
 * User-defined keyword alert rule: when any of `keywords` match an incoming
 * message body / topic / summary, an AlertTriggerDocument is created.
 */
export interface AlertRuleDocument {
  _id?: ObjectId;
  name: string;
  /** Lowercase substrings matched against body, topic, and summary. */
  keywords: string[];
  /** Optional groupJid scope; empty = all tracked groups. */
  groupJids: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type PurchaseOrderStatus =
  | "ordered"
  | "in_transit"
  | "delayed"
  | "delivered"
  | "unknown";

/**
 * Master record for a purchase order being tracked. POs are seeded or created
 * by the user, and enriched in-place by the message pipeline whenever an
 * incoming WhatsApp message in a tracked group mentions the PO number.
 */
export interface PurchaseOrderDocument {
  _id?: ObjectId;
  /** Canonical PO/AWB/invoice reference. Compared case-insensitively. */
  poNumber: string;
  productName: string;
  companyName: string;
  /** Expected delivery date — may be revised by incoming messages. */
  eta: Date | null;
  status: PurchaseOrderStatus;
  /** True after we sent a follow-up that mentioned this PO and the supplier
   *  hasn't replied since. Flips to false the moment a non-fromMe message in
   *  the same group references this PO. */
  awaitingReply: boolean;
  /** Last message that touched this PO (any direction). */
  lastUpdateMsgId: string | null;
  lastUpdateAt: Date | null;
  /** Optional free-form notes (manual entry only). */
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertTriggerDocument {
  _id?: ObjectId;
  ruleId: ObjectId;
  ruleName: string;
  matchedKeywords: string[];
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  body: string;
  topic: string | null;
  triggeredAt: Date;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
}
