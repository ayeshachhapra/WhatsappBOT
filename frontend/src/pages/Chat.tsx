import { useEffect, useRef, useState } from "react";
import { api, CitedMessage, GroupRef } from "../api";
import MarkdownView from "../components/MarkdownView";

interface FollowUpSuggestion {
  groupName: string;
  message: string;
  sender?: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  citations?: CitedMessage[];
  followUp?: FollowUpSuggestion | null;
  done?: boolean;
}

const FOLLOW_UP_RE = /\[FOLLOW_UP_SUGGESTION\]([\s\S]*?)\[\/FOLLOW_UP_SUGGESTION\]/i;

function parseFollowUp(text: string): {
  cleaned: string;
  followUp: FollowUpSuggestion | null;
} {
  const match = text.match(FOLLOW_UP_RE);
  if (!match) return { cleaned: text, followUp: null };

  const block = match[1];
  const groupMatch = block.match(/group\s*:\s*(.+)/i);
  const senderMatch = block.match(/sender\s*:\s*(.+)/i);
  const messageMatch = block.match(/message\s*:\s*([\s\S]+?)(?:\n\s*$|$)/i);
  const groupName = (groupMatch?.[1] || "").trim();
  const sender = (senderMatch?.[1] || "").trim() || undefined;
  const messageText = (messageMatch?.[1] || "").trim();

  if (!groupName || !messageText) {
    return { cleaned: text.replace(FOLLOW_UP_RE, "").trim(), followUp: null };
  }

  return {
    cleaned: text.replace(FOLLOW_UP_RE, "").trim(),
    followUp: { groupName, message: messageText, sender },
  };
}

const SUGGESTIONS = [
  "Has PO #1234 been dispatched?",
  "What is the latest ETA from Acme Logistics?",
  "Any updates on the shipment from Mumbai warehouse this week?",
  "Which deliveries are pending confirmation?",
];

interface ChatProps {
  /** Hide the page heading + intro paragraph (use when embedded in another page). */
  embedded?: boolean;
}

export default function Chat({ embedded = false }: ChatProps = {}) {
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const histRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ groups: GroupRef[] }>("/api/groups/tracked")
      .then(({ groups }) => setTracked(groups || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    histRef.current?.scrollTo({
      top: histRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history, status]);

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || streaming) return;
    const userMsg: Msg = { role: "user", content: text };
    setHistory((h) => [...h, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setStatus("Connecting...");

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: history.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text();
        throw new Error(errText || "stream failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let cites: CitedMessage[] | undefined;
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evt of events) {
          if (!evt.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(evt.slice(6));
            if (payload.type === "status") {
              setStatus(payload.data);
            } else if (payload.type === "chunk") {
              assistantText += payload.data;
              setStatus(null);
              const { cleaned } = parseFollowUp(assistantText);
              setHistory((h) => {
                const next = [...h];
                next[next.length - 1] = {
                  role: "assistant",
                  content: cleaned,
                  citations: cites,
                  done: false,
                };
                return next;
              });
            } else if (payload.type === "citations") {
              cites = payload.citations;
              setHistory((h) => {
                const next = [...h];
                next[next.length - 1] = {
                  ...next[next.length - 1],
                  citations: cites,
                };
                return next;
              });
            } else if (payload.type === "done") {
              const { cleaned, followUp } = parseFollowUp(assistantText);
              setHistory((h) => {
                const next = [...h];
                next[next.length - 1] = {
                  role: "assistant",
                  content: cleaned,
                  citations: cites,
                  followUp,
                  done: true,
                };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setHistory((h) => {
        const next = [...h];
        next[next.length - 1] = {
          role: "assistant",
          content: "Error: " + err.message,
          done: true,
        };
        return next;
      });
    } finally {
      setStreaming(false);
      setStatus(null);
    }
  }

  function findGroupByName(name: string): GroupRef | null {
    if (!name) return null;
    const lower = name.toLowerCase();
    return (
      tracked.find((g) => g.name.toLowerCase() === lower) ||
      tracked.find((g) => g.name.toLowerCase().includes(lower)) ||
      null
    );
  }

  return (
    <div className={embedded ? "chat-window embedded" : "chat-window"}>
      {!embedded && (
        <>
          <h2>Ask about your deliveries</h2>
          <p className="muted">
            Ask anything about your purchase orders, dispatches, or shipments captured
            from WhatsApp. The AI can draft follow-ups, set up auto-chases, and
            acknowledge updates — all from each answer.
          </p>
        </>
      )}

      <div className="chat-history" ref={histRef}>
        {history.length === 0 && (
          <div>
            <div className="muted" style={{ marginBottom: 12 }}>Try one of these:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  className="btn-secondary btn"
                  onClick={() => send(s)}
                  style={{ fontSize: 13 }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === "assistant" ? (
              m.content ? (
                <MarkdownView>{m.content}</MarkdownView>
              ) : (
                <div className="muted">
                  {streaming && i === history.length - 1
                    ? status || "Thinking..."
                    : ""}
                </div>
              )
            ) : (
              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
            )}

            {m.role === "assistant" && m.followUp && (
              <FollowUpCard
                followUp={m.followUp}
                trackedGroup={findGroupByName(m.followUp.groupName)}
                allTracked={tracked}
                originalQuestion={
                  history[i - 1]?.role === "user" ? history[i - 1].content : ""
                }
                answerSnippet={m.content.slice(0, 400)}
              />
            )}

            {m.role === "assistant" && m.done && m.content && (
              <ActionBar
                answer={m.content}
                citations={m.citations || []}
                originalQuestion={
                  history[i - 1]?.role === "user" ? history[i - 1].content : ""
                }
                allTracked={tracked}
                preferredGroupName={m.followUp?.groupName}
                preferredSender={m.followUp?.sender}
              />
            )}

            {m.role === "assistant" && m.citations && m.citations.length > 0 && (
              <Sources citations={m.citations} />
            )}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <input
          placeholder="Where is my PO #1234? Has the Mumbai shipment cleared customs?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={streaming}
        />
        <button
          className="btn"
          onClick={() => send()}
          disabled={streaming || !input.trim()}
        >
          {streaming ? "..." : "Ask"}
        </button>
      </div>
    </div>
  );
}

// ─── Auto-suggest follow-up card ───────────────────────────

interface FollowUpCardProps {
  followUp: FollowUpSuggestion;
  trackedGroup: GroupRef | null;
  allTracked: GroupRef[];
  originalQuestion: string;
  answerSnippet: string;
}

function FollowUpCard({
  followUp,
  trackedGroup,
  allTracked,
  originalQuestion,
  answerSnippet,
}: FollowUpCardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(followUp.message);
  const [chosenJid, setChosenJid] = useState<string>(trackedGroup?.jid || "");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<"draft" | "sent" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const targetGroup =
    allTracked.find((g) => g.jid === chosenJid) || trackedGroup || null;

  function buildMeta() {
    return {
      chatQuestion: originalQuestion || undefined,
      chatAnswerSnippet: answerSnippet || undefined,
      triggerSender: followUp.sender || undefined,
    };
  }

  async function saveAsDraft() {
    if (!targetGroup) return setErr("Pick a group");
    setSending(true);
    setErr(null);
    try {
      await api.post("/api/drafts", {
        draftText: text,
        targetGroups: [targetGroup],
        label: followUp.sender ? `Follow-up to ${followUp.sender}` : "AI follow-up",
        meta: buildMeta(),
      });
      setDone("draft");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  async function sendNow() {
    if (!targetGroup) return setErr("Pick a group");
    setSending(true);
    setErr(null);
    try {
      const draft = await api.post<{ id: string }>("/api/drafts", {
        draftText: text,
        targetGroups: [targetGroup],
        label: followUp.sender
          ? `Follow-up to ${followUp.sender} (sent)`
          : "AI follow-up — sent",
        meta: buildMeta(),
      });
      await api.post(`/api/drafts/${draft.id}/approve`);
      setDone("sent");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="follow-up-card">
      <div className="follow-up-head">
        <strong>📨 Suggested follow-up</strong>
        {targetGroup ? (
          <span className="muted" style={{ fontSize: 12 }}>
            → {targetGroup.name}
            {followUp.sender && (
              <>
                {" "}· addressed to <strong>{followUp.sender}</strong>
              </>
            )}
          </span>
        ) : isWildcardGroup(followUp.groupName) ? (
          <span className="muted" style={{ fontSize: 12 }}>
            Pick a group below to send to
          </span>
        ) : (
          <span style={{ color: "var(--warn)", fontSize: 12 }}>
            (group "{followUp.groupName}" not tracked — pick one below)
          </span>
        )}
      </div>

      {editing ? (
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ marginBottom: 8 }}
        />
      ) : (
        <div className="follow-up-body">{text}</div>
      )}

      {!targetGroup && allTracked.length > 0 && (
        <select
          value={chosenJid}
          onChange={(e) => setChosenJid(e.target.value)}
          style={{ marginBottom: 8 }}
        >
          <option value="">— Choose target group —</option>
          {allTracked.map((g) => (
            <option key={g.jid} value={g.jid}>
              {g.name}
            </option>
          ))}
        </select>
      )}

      {err && (
        <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 6 }}>
          {err}
        </div>
      )}

      {done === "sent" ? (
        <div style={{ color: "var(--accent)", fontSize: 13 }}>
          ✓ Sent to {targetGroup?.name}.
        </div>
      ) : done === "draft" ? (
        <div style={{ color: "var(--accent)", fontSize: 13 }}>
          ✓ Saved to Follow-ups → review there to send.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn-secondary btn"
            onClick={() => setEditing(!editing)}
            style={{ flex: 0, padding: "6px 12px", fontSize: 13 }}
          >
            {editing ? "Done editing" : "Edit"}
          </button>
          <button
            className="btn-secondary btn"
            onClick={saveAsDraft}
            disabled={sending}
            style={{ flex: 0, padding: "6px 12px", fontSize: 13 }}
          >
            {sending ? "..." : "Save as draft"}
          </button>
          <button
            className="btn"
            onClick={sendNow}
            disabled={sending}
            style={{ flex: 0, padding: "6px 12px", fontSize: 13 }}
          >
            {sending ? "..." : "Send now"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Action bar (always visible on every assistant answer) ──────

interface ActionBarProps {
  answer: string;
  citations: CitedMessage[];
  originalQuestion: string;
  allTracked: GroupRef[];
  preferredGroupName?: string;
  preferredSender?: string;
}

function ActionBar({
  answer,
  citations,
  originalQuestion,
  allTracked,
  preferredGroupName,
  preferredSender,
}: ActionBarProps) {
  const [showChase, setShowChase] = useState(false);
  const [showAck, setShowAck] = useState(false);

  const candidate = pickCandidateFromCitations(
    citations,
    preferredGroupName,
    preferredSender,
    allTracked
  );

  return (
    <>
      <div className="answer-actions">
        <button
          className="btn-secondary btn"
          onClick={() => setShowAck(true)}
          title="Draft a thank-you / acknowledgement"
        >
          ✓ Acknowledge
        </button>
        <button
          className="btn-secondary btn"
          onClick={() => setShowChase(true)}
          title="Send daily reminders until the group responds"
        >
          🔁 Auto-chase daily
        </button>
      </div>

      {showAck && (
        <AcknowledgeModal
          onClose={() => setShowAck(false)}
          allTracked={allTracked}
          defaultGroup={candidate.group}
          defaultSender={preferredSender || candidate.sender}
          defaultSenderJid={candidate.senderJid}
          originalQuestion={originalQuestion}
          answerSnippet={answer.slice(0, 400)}
        />
      )}
      {showChase && (
        <AutoChaseModal
          onClose={() => setShowChase(false)}
          allTracked={allTracked}
          defaultGroup={candidate.group}
          defaultSender={preferredSender || candidate.sender}
          defaultSenderJid={candidate.senderJid}
          originalQuestion={originalQuestion}
          answerSnippet={answer.slice(0, 400)}
        />
      )}
    </>
  );
}

function pickCandidateFromCitations(
  citations: CitedMessage[],
  preferredGroupName: string | undefined,
  preferredSender: string | undefined,
  allTracked: GroupRef[]
): { group: GroupRef | null; sender: string | undefined; senderJid: string | undefined } {
  if (preferredGroupName) {
    const lower = preferredGroupName.toLowerCase();
    const exact =
      allTracked.find((g) => g.name.toLowerCase() === lower) ||
      allTracked.find((g) => g.name.toLowerCase().includes(lower));
    if (exact) {
      const cites = citations.filter(
        (c) => c.groupName.toLowerCase() === exact.name.toLowerCase()
      );
      const matched = preferredSender
        ? cites.find((c) =>
            c.sender.toLowerCase().includes(preferredSender.toLowerCase().split(/\s+/)[0])
          )
        : null;
      const cite = matched || cites[0];
      return { group: exact, sender: cite?.sender, senderJid: cite?.senderJid };
    }
  }
  if (citations.length > 0) {
    const cite = citations[0];
    const group = allTracked.find(
      (g) => g.name.toLowerCase() === cite.groupName.toLowerCase()
    );
    return { group: group || null, sender: cite.sender, senderJid: cite.senderJid };
  }
  return { group: null, sender: undefined, senderJid: undefined };
}

// ─── Acknowledge modal ───────────────────────────

function AcknowledgeModal({
  onClose,
  allTracked,
  defaultGroup,
  defaultSender,
  defaultSenderJid,
  originalQuestion,
  answerSnippet,
}: {
  onClose: () => void;
  allTracked: GroupRef[];
  defaultGroup: GroupRef | null;
  defaultSender: string | undefined;
  defaultSenderJid: string | undefined;
  originalQuestion: string;
  answerSnippet: string;
}) {
  const initial = defaultSender
    ? `Thanks ${firstName(defaultSender)}, much appreciated. Please share the AWB / tracking link once dispatched.`
    : `Thanks for the update — much appreciated. Please share the AWB / tracking link once dispatched.`;
  const [text, setText] = useState(initial);
  const [groupJid, setGroupJid] = useState(defaultGroup?.jid || "");
  const [mention, setMention] = useState<boolean>(!!defaultSenderJid);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const target = allTracked.find((g) => g.jid === groupJid) || null;

  async function save(send: boolean) {
    if (!target) return setErr("Pick a group");
    setSending(true);
    setErr(null);
    try {
      const draft = await api.post<{ id: string }>("/api/drafts", {
        draftText: text,
        targetGroups: [target],
        label: "Acknowledgement",
        mentionJids: mention && defaultSenderJid ? [defaultSenderJid] : undefined,
        meta: {
          chatQuestion: originalQuestion || undefined,
          chatAnswerSnippet: answerSnippet || undefined,
          triggerSender: defaultSender,
        },
      });
      if (send) await api.post(`/api/drafts/${draft.id}/approve`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px" }}>Send acknowledgement</h3>
        <label>Target group</label>
        <select value={groupJid} onChange={(e) => setGroupJid(e.target.value)}>
          <option value="">— Choose —</option>
          {allTracked.map((g) => (
            <option key={g.jid} value={g.jid}>{g.name}</option>
          ))}
        </select>
        <div style={{ marginTop: 12 }}>
          <label>Message</label>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {defaultSenderJid && (
          <div style={{ marginTop: 8 }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={mention}
                onChange={(e) => setMention(e.target.checked)}
              />
              @-mention {defaultSender || "the recipient"} in WhatsApp
            </label>
          </div>
        )}
        {err && <div style={{ color: "var(--danger)", marginTop: 8, fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="btn-secondary btn" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button className="btn-secondary btn" onClick={() => save(false)} disabled={sending}>
            Save as draft
          </button>
          <button className="btn" onClick={() => save(true)} disabled={sending}>
            {sending ? "..." : "Send now"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Auto-chase modal ───────────────────────────

function AutoChaseModal({
  onClose,
  allTracked,
  defaultGroup,
  defaultSender,
  defaultSenderJid,
  originalQuestion,
  answerSnippet,
}: {
  onClose: () => void;
  allTracked: GroupRef[];
  defaultGroup: GroupRef | null;
  defaultSender: string | undefined;
  defaultSenderJid: string | undefined;
  originalQuestion: string;
  answerSnippet: string;
}) {
  const initial = defaultSender
    ? `Hi ${firstName(defaultSender)}, just checking in — any update on this? Appreciate a quick line whenever you can.`
    : `Hi team, just checking in on this — any update? Appreciate a quick line whenever you can.`;
  const [text, setText] = useState(initial);
  const [groupJid, setGroupJid] = useState(defaultGroup?.jid || "");
  const [mention, setMention] = useState<boolean>(!!defaultSenderJid);
  const [time, setTime] = useState("10:00");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const target = allTracked.find((g) => g.jid === groupJid) || null;

  async function create() {
    if (!target) return setErr("Pick a group");
    setCreating(true);
    setErr(null);
    try {
      await api.post("/api/auto-chase", {
        name: defaultSender
          ? `Auto-chase: ${defaultSender} — ${truncate(originalQuestion, 40)}`
          : `Auto-chase: ${truncate(originalQuestion, 40)}`,
        messageText: text,
        targetGroups: [target],
        mentionJids: mention && defaultSenderJid ? [defaultSenderJid] : undefined,
        time,
        cadenceDays: 1,
        meta: {
          chatQuestion: originalQuestion || undefined,
          chatAnswerSnippet: answerSnippet || undefined,
          triggerSender: defaultSender,
        },
      });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 6px" }}>🔁 Auto-chase daily</h3>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
          Sends this message daily at the chosen time, and auto-stops as soon as
          anyone in the target group sends a reply.
        </p>
        <label>Target group</label>
        <select value={groupJid} onChange={(e) => setGroupJid(e.target.value)}>
          <option value="">— Choose —</option>
          {allTracked.map((g) => (
            <option key={g.jid} value={g.jid}>{g.name}</option>
          ))}
        </select>
        <div style={{ marginTop: 12 }}>
          <label>Send at</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <label>Message</label>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {defaultSenderJid && (
          <div style={{ marginTop: 8 }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={mention}
                onChange={(e) => setMention(e.target.checked)}
              />
              @-mention {defaultSender || "the recipient"} on each chase
            </label>
          </div>
        )}
        {err && <div style={{ color: "var(--danger)", marginTop: 8, fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="btn-secondary btn" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button className="btn" onClick={create} disabled={creating}>
            {creating ? "..." : "Start auto-chase"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Sources({ citations }: { citations: CitedMessage[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="muted"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          fontSize: 12,
          marginBottom: open ? 6 : 0,
          color: "var(--muted)",
        }}
      >
        {open ? "▾" : "▸"} Sources ({citations.length})
      </button>
      {open &&
        citations.slice(0, 5).map((c, idx) => (
          <div
            key={idx}
            className="muted"
            style={{ fontSize: 12, marginBottom: 4 }}
          >
            [{idx + 1}] <strong>{c.groupName}</strong> ·{" "}
            {c.fromMe ? (
              <span style={{ color: "var(--accent)", fontWeight: 500 }}>You</span>
            ) : (
              c.sender
            )}{" "}
            · {new Date(c.timestamp).toLocaleString()}
            {c.topic && (
              <>
                {" "}· <em>{c.topic}</em>
              </>
            )}
          </div>
        ))}
    </div>
  );
}

function firstName(full: string): string {
  if (!full) return "there";
  return full.split(/\s+/)[0];
}

function isWildcardGroup(name: string | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return (
    n === "any" ||
    n === "any tracked group" ||
    n === "any group" ||
    n === "unknown" ||
    n === "n/a" ||
    n === "none"
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}
