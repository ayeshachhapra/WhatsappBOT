import { useEffect, useMemo, useRef, useState } from "react";
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
  // Each label is anchored to its own line so an empty `sender:` line can't
  // greedily slurp the next line's `message:` content into the sender field.
  const groupMatch = block.match(/^[ \t]*group[ \t]*:[ \t]*(.+?)[ \t]*$/im);
  const senderMatch = block.match(/^[ \t]*sender[ \t]*:[ \t]*(.+?)[ \t]*$/im);
  const messageMatch = block.match(/message[ \t]*:[ \t]*([\s\S]+?)(?:\n\s*$|$)/i);
  const groupName = (groupMatch?.[1] || "").trim();
  let sender = (senderMatch?.[1] || "").trim() || undefined;
  const messageText = (messageMatch?.[1] || "").trim();
  // Defensive: if the AI accidentally crammed extra labels into the sender
  // value (e.g. "sender: message: Hi..."), strip everything after the first
  // line and any trailing label.
  if (sender) {
    sender = sender.split(/\n/)[0].split(/\b(?:message|group)\s*:/i)[0].trim();
    if (!sender) sender = undefined;
  }

  if (!groupName || !messageText) {
    return { cleaned: text.replace(FOLLOW_UP_RE, "").trim(), followUp: null };
  }

  return {
    cleaned: text.replace(FOLLOW_UP_RE, "").trim(),
    followUp: { groupName, message: messageText, sender },
  };
}

const SUGGESTIONS = [
  "Where is PO-1001? Has it been dispatched yet?",
  "Which orders are delayed and why?",
  "What's the latest update from Bharat Metals on PO-1002?",
  "Which deliveries are coming up in the next 3 days?",
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
                citations={m.citations || []}
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
          placeholder="Where is PO-1003? What's the latest from SKF Distributors?"
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
  citations: CitedMessage[];
  originalQuestion: string;
  answerSnippet: string;
}

interface MentionTarget {
  jid: string;
  name?: string;
}

function FollowUpCard({
  followUp,
  trackedGroup,
  allTracked,
  citations,
  originalQuestion,
  answerSnippet,
}: FollowUpCardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(followUp.message);
  const [chosenJid, setChosenJid] = useState<string>(trackedGroup?.jid || "");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<"draft" | "sent" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState<MentionTarget | null>(null);
  const [resolveStatus, setResolveStatus] = useState<string | null>(null);

  const targetGroup =
    allTracked.find((g) => g.jid === chosenJid) || trackedGroup || null;

  // Smart supplier lookup: extract any PO/AWB/invoice ref from the message and
  // ask the backend who has actually been talking about it in the chosen group.
  // That's far more reliable than trusting the AI's name guess in followUp.sender.
  // Falls back to chat citations if no ref is detectable.
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      const refs = extractRefs(text);
      if (refs.length === 0 || !targetGroup) {
        const fallback = resolveMentionFromCitations(
          followUp.sender,
          targetGroup,
          citations
        );
        if (!cancelled) {
          setResolvedTarget(fallback);
          setResolveStatus(
            fallback ? `via chat citations (${fallback.name})` : null
          );
        }
        return;
      }
      // Try refs in order — first hit wins.
      for (const ref of refs) {
        try {
          const params = new URLSearchParams({
            ref,
            groupJid: targetGroup.jid,
          });
          const result = await api.get<{
            senderJid: string | null;
            sender: string | null;
            source?: string;
          }>(`/api/messages/mention-target?${params.toString()}`);
          if (cancelled) return;
          if (result.senderJid && result.sender) {
            setResolvedTarget({
              jid: result.senderJid,
              name: firstName(result.sender),
            });
            setResolveStatus(
              `${result.sender} actually discusses ${ref} in this group${
                result.source === "lid_only" ? " (no phone JID — pill may not render)" : ""
              }`
            );
            return;
          }
        } catch {
          // try next ref
        }
      }
      // No ref-based hit — fall back to citations
      const fallback = resolveMentionFromCitations(
        followUp.sender,
        targetGroup,
        citations
      );
      if (!cancelled) {
        setResolvedTarget(fallback);
        setResolveStatus(
          fallback
            ? `via chat citations (${fallback.name})`
            : "no supplier history for this PO yet — message will send untagged"
        );
      }
    }
    resolve();
    return () => {
      cancelled = true;
    };
  }, [text, targetGroup?.jid, followUp.sender, citations]);

  // Rewrite salutation: if the AI guessed "Hi Enrique" but the actual supplier
  // is "Manuel", swap "Hi Enrique" → "Hi @Manuel" in the displayed text once.
  // Only kicks in when we resolved a target via refs (high-confidence) AND the
  // user hasn't manually edited away the salutation.
  useEffect(() => {
    if (!resolvedTarget?.name || editing) return;
    const rewritten = rewriteSalutation(
      text,
      resolvedTarget.name,
      followUp.sender
    );
    if (rewritten !== text) {
      setText(rewritten);
    }
    // We intentionally exclude `text` from deps — this is a one-shot rewrite
    // when the resolved target changes, not a loop over edits the user makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTarget?.jid]);

  const mentionRef = resolvedTarget;

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
        mentions: mentionRef ? [mentionRef] : undefined,
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
        mentions: mentionRef ? [mentionRef] : undefined,
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
        <div className="follow-up-title">📨 Suggested follow-up</div>
        {targetGroup ? (
          <div className="follow-up-meta">
            <span className="follow-up-chip">→ {targetGroup.name}</span>
            {followUp.sender && (
              <span className="follow-up-chip">
                addressed to <strong>{followUp.sender}</strong>
              </span>
            )}
          </div>
        ) : isWildcardGroup(followUp.groupName) ? (
          <div className="follow-up-meta">
            <span className="muted" style={{ fontSize: 12 }}>
              Pick a group below to send to
            </span>
          </div>
        ) : (
          <div className="follow-up-meta">
            <span style={{ color: "var(--warn)", fontSize: 12 }}>
              Group "{followUp.groupName}" not tracked — pick one below
            </span>
          </div>
        )}
      </div>

      {editing ? (
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ marginBottom: 8 }}
        />
      ) : (
        <div className="follow-up-body">{text}</div>
      )}

      {resolveStatus && (
        <div className="follow-up-tagging">
          <span className="follow-up-tagging-icon">🏷</span>
          <span>
            <strong>Tagging:</strong> {resolveStatus}
          </span>
        </div>
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
        <div className="follow-up-done">✓ Sent to {targetGroup?.name}.</div>
      ) : done === "draft" ? (
        <div className="follow-up-done">
          ✓ Saved to Follow-ups → review there to send.
        </div>
      ) : (
        <div className="follow-up-actions">
          <button
            className="btn-secondary btn"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Done editing" : "Edit"}
          </button>
          <button
            className="btn-secondary btn"
            onClick={saveAsDraft}
            disabled={sending}
          >
            {sending ? "..." : "Save as draft"}
          </button>
          <button className="btn" onClick={sendNow} disabled={sending}>
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
  // We never want to @-tag ourselves on a follow-up — the mention should land
  // on the supplier we're chasing. Drop fromMe citations from candidate picking
  // (they still appear in Sources for transparency, just not as mention targets).
  const otherSide = citations.filter((c) => !c.fromMe);

  if (preferredGroupName) {
    const lower = preferredGroupName.toLowerCase();
    const exact =
      allTracked.find((g) => g.name.toLowerCase() === lower) ||
      allTracked.find((g) => g.name.toLowerCase().includes(lower));
    if (exact) {
      const cites = otherSide.filter(
        (c) => c.groupName.toLowerCase() === exact.name.toLowerCase()
      );
      const matched = preferredSender
        ? cites.find((c) =>
            c.sender.toLowerCase().includes(preferredSender.toLowerCase().split(/\s+/)[0])
          )
        : null;
      const cite = matched || cites[0];
      // Even if we found the group, only return a sender/jid when there's a
      // non-fromMe citation in it — otherwise the modal will leave the mention
      // toggle off rather than defaulting to the bot owner.
      return {
        group: exact,
        sender: cite?.sender,
        senderJid: cite?.senderJid,
      };
    }
  }
  if (otherSide.length > 0) {
    const cite = otherSide[0];
    const group = allTracked.find(
      (g) => g.name.toLowerCase() === cite.groupName.toLowerCase()
    );
    return { group: group || null, sender: cite.sender, senderJid: cite.senderJid };
  }
  // Fall back to picking just the group from the first citation (any direction)
  // so the modal still defaults to a sensible target — but with no mention.
  if (citations.length > 0) {
    const cite = citations[0];
    const group = allTracked.find(
      (g) => g.name.toLowerCase() === cite.groupName.toLowerCase()
    );
    return { group: group || null, sender: undefined, senderJid: undefined };
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
  const senderFirst = defaultSender ? firstName(defaultSender) : "";
  const initial = defaultSender
    ? `Thanks @${senderFirst}, much appreciated. Please share the AWB / tracking link once dispatched.`
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
        mentions:
          mention && defaultSenderJid
            ? [{ jid: defaultSenderJid, name: senderFirst || undefined }]
            : undefined,
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
  const senderFirst = defaultSender ? firstName(defaultSender) : "";
  const initial = defaultSender
    ? `Hi @${senderFirst}, just checking in — any update on this? Appreciate a quick line whenever you can.`
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
        mentions:
          mention && defaultSenderJid
            ? [{ jid: defaultSenderJid, name: senderFirst || undefined }]
            : undefined,
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

/**
 * Extract PO/AWB/invoice-style references from a free-text message body.
 * Returns the canonical token (e.g. "PO-1001" or "1001") in order of first
 * appearance — used as candidate ref keys for the mention-target lookup.
 */
function extractRefs(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // PO / AWB / INV / Invoice / Bill prefix, optional separator, then digits/letters
  const prefixed = /\b(?:PO|AWB|INV|invoice|bill|order)\s*#?\s*-?\s*([A-Z0-9][A-Z0-9-]{2,20})/gi;
  let m: RegExpExecArray | null;
  while ((m = prefixed.exec(text)) !== null) {
    const ref = m[1].toUpperCase().replace(/^-+|-+$/g, "");
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  // Standalone tokens that look like PO numbers (e.g. "PO-1001" appearing without
  // the prefix anywhere in the text — also catches "1001" if explicitly cited).
  const standalone = /\b(PO-\d{3,8}|AWB-?\d{4,12}|INV-?\d{3,10})\b/gi;
  while ((m = standalone.exec(text)) !== null) {
    const ref = m[1].toUpperCase();
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

const SALUTATION_RE =
  /^(Hi|Hello|Hey|Thanks?|Dear)\s+@?([A-Z][a-zA-Z'-]+)(\b|,)/;

/**
 * If the AI wrote "Hi Enrique" but the resolved supplier is "Manuel", swap
 * the wrong name in the salutation for `@<correctName>`. Only rewrites when:
 *   - the salutation pattern matches at the start of the message
 *   - the wrong name is what the AI guessed (followUp.sender) — protects against
 *     stomping on names the user manually typed in mid-message
 *   - the correct name differs (case-insensitive) from the AI's guess
 */
function rewriteSalutation(
  body: string,
  correctName: string,
  aiGuess: string | undefined
): string {
  if (!correctName) return body;
  const match = body.match(SALUTATION_RE);
  if (!match) return body;
  const greeting = match[1];
  const currentName = match[2];
  const rest = body.slice(match[0].length - (match[3] === "," ? 1 : 0));

  if (currentName.toLowerCase() === correctName.toLowerCase()) {
    // Already correct — just ensure the @ is present.
    if (body.startsWith(`${greeting} @${currentName}`)) return body;
    return `${greeting} @${currentName}${rest}`;
  }
  // Only overwrite when the AI itself put the wrong name there. If the user
  // edited it to something else, leave it alone.
  const aiFirst = (aiGuess || "").trim().split(/\s+/)[0];
  if (
    aiFirst &&
    aiFirst.toLowerCase() !== currentName.toLowerCase() &&
    correctName.toLowerCase() !== currentName.toLowerCase()
  ) {
    return body;
  }
  return `${greeting} @${correctName}${rest}`;
}

/**
 * Find the supplier we should @-tag for an AI-suggested follow-up.
 * We pick from `citations` (the chat's grounding messages) — never fromMe —
 * preferring a citation in the chosen target group whose sender's first name
 * matches the AI's `followUp.sender` field.
 *
 * Returns `{ jid, name }` so the manager can splice an @-pill into the body
 * regardless of whether the AI wrote "Hi Enrique" or "Hi @Enrique".
 */
function resolveMentionFromCitations(
  senderHint: string | undefined,
  targetGroup: GroupRef | null,
  citations: CitedMessage[]
): { jid: string; name?: string } | null {
  const otherSide = citations.filter(
    (c) => !c.fromMe && c.senderJid && c.senderJid.includes("@s.whatsapp.net")
  );
  if (otherSide.length === 0) return null;

  const inGroup = targetGroup
    ? otherSide.filter(
        (c) => c.groupName.toLowerCase() === targetGroup.name.toLowerCase()
      )
    : otherSide;
  const pool = inGroup.length > 0 ? inGroup : otherSide;

  const hint = (senderHint || "").trim().toLowerCase().split(/\s+/)[0];
  const matched = hint
    ? pool.find((c) => c.sender.toLowerCase().split(/\s+/)[0] === hint) ||
      pool.find((c) => c.sender.toLowerCase().includes(hint))
    : null;

  const cite = matched || pool[0];
  if (!cite) return null;
  return { jid: cite.senderJid, name: firstName(cite.sender) };
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
