import { useEffect, useState } from "react";
import { api, GroupRef, MessageDoc } from "../api";

interface Thread {
  topic: string;
  count: number;
  firstAt: string;
  lastAt: string;
  groups: GroupRef[];
  senders: string[];
  entities: string[];
  openActions: string[];
  negativeCount: number;
}

export default function Threads() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    try {
      const { threads } = await api.get<{ threads: Thread[] }>("/api/threads");
      setThreads(threads);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function open(topic: string) {
    setSelected(topic);
    setMessages([]);
    try {
      const { messages } = await api.get<{ messages: MessageDoc[] }>(
        "/api/threads/" + encodeURIComponent(topic)
      );
      setMessages(messages);
    } catch {}
  }

  const visible = filter
    ? threads.filter(
        (t) =>
          t.topic.toLowerCase().includes(filter.toLowerCase()) ||
          t.groups.some((g) => g.name.toLowerCase().includes(filter.toLowerCase())) ||
          t.entities.some((e) => e.toLowerCase().includes(filter.toLowerCase()))
      )
    : threads;

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Conversations grouped by topic — across senders, dates, and groups.
      </p>

      <div className="card">
        <div className="row">
          <input
            placeholder="Filter by topic, group, or entity..."
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

      {visible.length === 0 && !loading && (
        <div className="muted">
          No threads yet. Threads appear when 2+ messages share the same topic.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          {visible.map((t) => (
            <div
              key={t.topic}
              className="card"
              style={{
                cursor: "pointer",
                borderColor:
                  selected?.toLowerCase() === t.topic.toLowerCase()
                    ? "var(--accent)"
                    : undefined,
              }}
              onClick={() => open(t.topic)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{t.topic}</strong>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <span className="tag">{t.count} msgs</span>
                  {t.negativeCount > 0 && (
                    <span className="tag" style={{ color: "var(--danger)" }}>
                      {t.negativeCount} ⚠
                    </span>
                  )}
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {new Date(t.firstAt).toLocaleDateString()} →{" "}
                {new Date(t.lastAt).toLocaleString()}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Groups: {t.groups.map((g) => g.name).join(", ")}
              </div>
              {t.entities.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {t.entities.slice(0, 6).map((e, i) => (
                    <span key={i} className="tag">{e}</span>
                  ))}
                </div>
              )}
              {t.openActions.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  <strong style={{ fontSize: 11, color: "var(--muted)" }}>OPEN ACTIONS:</strong>
                  {t.openActions.map((a, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12 }}>• {a}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          {selected ? (
            <div className="card" style={{ position: "sticky", top: 0 }}>
              <h3 style={{ margin: "0 0 12px" }}>{selected}</h3>
              {messages.length === 0 ? (
                <div className="muted">Loading...</div>
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
                        {new Date(m.timestamp).toLocaleString()} · {m.sender} · {m.groupName}
                        {m.sentiment && (
                          <>
                            {" "}·{" "}
                            <span
                              style={{
                                color:
                                  m.sentiment === "negative"
                                    ? "var(--danger)"
                                    : m.sentiment === "positive"
                                    ? "var(--accent)"
                                    : "var(--muted)",
                              }}
                            >
                              {m.sentiment}
                            </span>
                          </>
                        )}
                      </div>
                      <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>
                        {m.body}
                      </div>
                      {m.actionItems && m.actionItems.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 12 }}>
                          {m.actionItems.map((a, i) => (
                            <div key={i} className="muted">→ {a}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="muted" style={{ padding: 16 }}>
              Click a thread to see its full timeline.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
