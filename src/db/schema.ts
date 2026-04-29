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
  /** Optional WhatsApp JIDs to @-mention in the outbound message. */
  mentionJids?: string[];
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
  /** Optional WhatsApp JIDs to @-mention when this draft is sent. */
  mentionJids?: string[];
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
