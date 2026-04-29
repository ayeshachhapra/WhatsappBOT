async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {}
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: any) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: any) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: any) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export interface GroupRef {
  jid: string;
  name: string;
}

export interface MessageDoc {
  _id: string;
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  fromMe?: boolean;
  body: string;
  messageType: string;
  bodySource?: "text" | "ocr";
  timestamp: string;
  topic: string | null;
  summary: string | null;
  entities: string[];
  actionItems: string[];
  sentiment: "positive" | "neutral" | "negative" | null;
  referenceNumbers?: string[];
  dueDate?: string | null;
  extractedAt: string | null;
  createdAt: string;
}

export type PurchaseOrderStatus =
  | "ordered"
  | "in_transit"
  | "delayed"
  | "delivered"
  | "unknown";

export interface PurchaseOrder {
  _id: string;
  poNumber: string;
  productName: string;
  companyName: string;
  eta: string | null;
  status: PurchaseOrderStatus;
  awaitingReply: boolean;
  lastUpdateMsgId: string | null;
  lastUpdateAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderSummary {
  ref: string;
  count: number;
  firstAt: string;
  lastAt: string;
  groups: GroupRef[];
  senders: string[];
  dueDate: string | null;
  status: "delivered" | "in_transit" | "delayed" | "ordered" | "unknown";
  lastBody: string;
  /** True when the most recent message tagged with this ref was sent by us. */
  lastFromMe: boolean;
}

export interface SenderSummary {
  senderJid: string;
  sender: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  groups: GroupRef[];
  negativeCount: number;
  positiveCount: number;
  recentTopics: string[];
  lastBody: string;
}

export interface AlertRule {
  _id: string;
  name: string;
  keywords: string[];
  groupJids: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertTrigger {
  _id: string;
  ruleId: string;
  ruleName: string;
  matchedKeywords: string[];
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  body: string;
  topic: string | null;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

export interface ScheduleDoc {
  _id: string;
  name: string;
  mode: "static" | "ai_draft";
  messageText: string | null;
  aiPrompt: string | null;
  targetGroups: GroupRef[];
  schedule: { times: string[]; days: number[] };
  enabled: boolean;
  autoSend: boolean;
  lastSentAt: string | null;
  lastSendResult: string | null;
  sendCount: number;
  createdAt: string;
}

export interface DraftMeta {
  chatQuestion?: string;
  chatAnswerSnippet?: string;
  triggerSender?: string;
}

export interface DraftDoc {
  _id: string;
  scheduleId: string | null;
  scheduleName: string;
  draftText: string;
  targetGroups: GroupRef[];
  status: "pending" | "approved" | "rejected" | "sent";
  source: "schedule" | "manual";
  meta: DraftMeta | null;
  createdAt: string;
  decidedAt: string | null;
  sentAt: string | null;
  sendError: string | null;
}

export type OutboxSource = "ai_chat" | "schedule" | "agent";
export type OutboxStatus =
  | "pending"
  | "sent"
  | "rejected"
  | "approved"
  | "failed";

export interface OutboxItem {
  id: string;
  source: OutboxSource;
  status: OutboxStatus;
  createdAt: string;
  sentAt: string | null;
  text: string;
  targetGroups: GroupRef[];
  refs: string[];
  draftId: string | null;
  agentActionId: string | null;
  scheduleName: string | null;
  chatQuestion: string | null;
  chatAnswerSnippet: string | null;
  triggerSender: string | null;
  triggerMsgId: string | null;
  reasoning: string | null;
  decision: string | null;
  mentionName: string | null;
  mentionJid: string | null;
  error: string | null;
}

export interface OutboxStats {
  pendingReview: number;
  sentToday: number;
  agentAuto24h: number;
  failed: number;
}

export type AttentionPriority = "critical" | "high" | "medium";
export type AttentionType =
  | "po_unreachable"
  | "po_late"
  | "po_long_silence"
  | "agent_escalation"
  | "pending_draft";

export interface AttentionItem {
  id: string;
  type: AttentionType;
  priority: AttentionPriority;
  headline: string;
  description: string;
  actionRoute: string;
  actionLabel: string;
  score: number;
  refs: string[];
  askQuery: string;
}

export interface AttentionBriefing {
  narrative: string;
  items: AttentionItem[];
}

export type AgentDecision =
  | "none"
  | "ask_clarifying"
  | "acknowledge"
  | "escalate";

export interface AgentSettings {
  _id: string;
  enabled: boolean;
  allowedGroupJids: string[];
  maxMessagesPerGroupPerHour: number;
  maxMessagesPerGroupPerDay: number;
  cooldownSeconds: number;
  mode: "active" | "observe";
  updatedAt: string;
}

export interface AgentActionRecord {
  _id: string;
  consideredAt: string;
  triggerMsgId: string;
  groupJid: string;
  groupName: string;
  senderName: string;
  senderJid: string;
  inboundBody: string;
  decision: AgentDecision;
  reasoning: string;
  outboundText: string | null;
  sent: boolean;
  skipReason: string | null;
  referenceNumbers: string[];
  mentionJid: string | null;
  mentionName: string | null;
  error: string | null;
}

export interface CitedMessage {
  groupName: string;
  groupJid: string;
  sender: string;
  senderJid: string;
  fromMe?: boolean;
  timestamp: string;
  body: string;
  topic: string | null;
}
