import { useEffect, useState } from "react";
import { api, MessageDoc, SenderSummary } from "../api";

export default function Senders() {
  const [senders, setSenders] = useState<SenderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { senders } = await api.get<{ senders: SenderSummary[] }>("/api/senders");
      setSenders(senders);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function open(senderJid: string) {
    setSelected(senderJid);
    setMessages([]);
    setMsgsLoading(true);
    try {
      const { messages } = await api.get<{ messages: MessageDoc[] }>(
        "/api/senders/" + encodeURIComponent(senderJid)
      );
      setMessages(messages);
    } finally {
      setMsgsLoading(false);
    }
  }

  const visible = filter
    ? senders.filter(
        (s) =>
          s.sender.toLowerCase().includes(filter.toLowerCase()) ||
          s.groups.some((g) => g.name.toLowerCase().includes(filter.toLowerCase())) ||
          s.recentTopics.some((t) => t.toLowerCase().includes(filter.toLowerCase()))
      )
    : senders;

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Everyone who's posted in your tracked groups, with recent topics and tone.
      </p>

      <div className="card">
        <div className="row">
          <input
            placeholder="Filter by name, group, or topic..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className="btn-secondary btn"
            onClick={load}
            disabled={loading}
            style={{ flex: 0 }}
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          {visible.map((s) => (
            <div
              key={s.senderJid}
              className="card"
              style={{
                cursor: "pointer",
                borderColor:
                  selected === s.senderJid ? "var(--accent)" : undefined,
              }}
              onClick={() => open(s.senderJid)}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <strong>{s.sender}</strong>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {s.senderJid.split("@")[0]}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {s.messageCount} msgs
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    last {new Date(s.lastMessageAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                In: {s.groups.map((g) => g.name).join(", ")}
              </div>
              {(s.negativeCount > 0 || s.positiveCount > 0) && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {s.positiveCount > 0 && (
                    <span className="tag" style={{ color: "var(--accent)" }}>
                      ↑ {s.positiveCount} positive
                    </span>
                  )}
                  {s.negativeCount > 0 && (
                    <span className="tag" style={{ color: "var(--danger)" }}>
                      ↓ {s.negativeCount} negative
                    </span>
                  )}
                </div>
              )}
              {s.recentTopics.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {s.recentTopics.slice(0, 5).map((t, i) => (
                    <span key={i} className="tag">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {visible.length === 0 && !loading && (
            <div className="muted">No senders match.</div>
          )}
        </div>

        <div>
          {selected ? (
            <div className="card" style={{ position: "sticky", top: 0 }}>
              <h3 style={{ margin: "0 0 12px" }}>
                {senders.find((s) => s.senderJid === selected)?.sender || selected}
              </h3>
              {msgsLoading ? (
                <div className="muted">Loading...</div>
              ) : messages.length === 0 ? (
                <div className="muted">No messages.</div>
              ) : (
                <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
                  {messages.map((m) => (
                    <div
                      key={m._id}
                      style={{
                        padding: "10px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div className="muted" style={{ fontSize: 11 }}>
                        {new Date(m.timestamp).toLocaleString()} · {m.groupName}
                        {m.sentiment && (
                          <span style={{ marginLeft: 6, color: m.sentiment === "negative" ? "var(--danger)" : m.sentiment === "positive" ? "var(--accent)" : "var(--muted)" }}>
                            ({m.sentiment})
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>
                        {m.body}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="muted" style={{ padding: 16 }}>
              Click a sender to see their message history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
