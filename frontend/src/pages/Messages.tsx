import { Fragment, useEffect, useState } from "react";
import { api, GroupRef, MessageDoc } from "../api";

export default function Messages() {
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ groupJid: "", sender: "", q: "", since: "", until: "", sentiment: "" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function loadTracked() {
    try {
      const { groups } = await api.get<{ groups: GroupRef[] }>("/api/groups/tracked");
      setTracked(groups);
    } catch {}
  }

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.groupJid) params.set("groupJid", filters.groupJid);
      if (filters.sender) params.set("sender", filters.sender);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", new Date(filters.since).toISOString());
      if (filters.until) params.set("until", new Date(filters.until).toISOString());
      if (filters.sentiment) params.set("sentiment", filters.sentiment);
      params.set("limit", "200");
      const data = await api.get<{ messages: MessageDoc[]; total: number }>(
        "/api/messages?" + params.toString()
      );
      setMessages(data.messages);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTracked();
    load();
  }, []);

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{total} total · showing {messages.length}</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select
            value={filters.groupJid}
            onChange={(e) => setFilters({ ...filters, groupJid: e.target.value })}
          >
            <option value="">All tracked groups</option>
            {tracked.map((g) => (
              <option key={g.jid} value={g.jid}>{g.name}</option>
            ))}
          </select>
          <input
            placeholder="Sender contains..."
            value={filters.sender}
            onChange={(e) => setFilters({ ...filters, sender: e.target.value })}
          />
          <input
            placeholder="Search text..."
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
          <select
            value={filters.sentiment}
            onChange={(e) => setFilters({ ...filters, sentiment: e.target.value })}
          >
            <option value="">Any sentiment</option>
            <option value="positive">Positive</option>
            <option value="neutral">Neutral</option>
            <option value="negative">Negative</option>
          </select>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <input
            type="date"
            value={filters.since}
            onChange={(e) => setFilters({ ...filters, since: e.target.value })}
          />
          <input
            type="date"
            value={filters.until}
            onChange={(e) => setFilters({ ...filters, until: e.target.value })}
          />
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Loading..." : "Apply"}
          </button>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Group</th>
              <th>Sender</th>
              <th>Topic</th>
              <th>Body</th>
              <th>Sentiment</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <Fragment key={m._id}>
                <tr onClick={() => setExpanded({ ...expanded, [m._id]: !expanded[m._id] })} style={{ cursor: "pointer" }}>
                  <td>{new Date(m.timestamp).toLocaleString()}</td>
                  <td>{m.groupName}</td>
                  <td>
                    {m.fromMe ? (
                      <span style={{ color: "var(--accent)", fontWeight: 500 }}>You</span>
                    ) : (
                      m.sender
                    )}
                  </td>
                  <td>{m.topic || <span className="muted">—</span>}</td>
                  <td style={{ maxWidth: 400 }}>{m.body.substring(0, 120)}{m.body.length > 120 ? "..." : ""}</td>
                  <td>{m.sentiment || <span className="muted">—</span>}</td>
                </tr>
                {expanded[m._id] && (
                  <tr>
                    <td colSpan={6} style={{ background: "var(--panel-2)", padding: 16 }}>
                      <div style={{ marginBottom: 8 }}><strong>Body:</strong> {m.body}</div>
                      {m.summary && <div style={{ marginBottom: 8 }}><strong>Summary:</strong> {m.summary}</div>}
                      {m.entities && m.entities.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Entities:</strong>{" "}
                          {m.entities.map((e, i) => <span className="tag" key={i}>{e}</span>)}
                        </div>
                      )}
                      {m.actionItems && m.actionItems.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Action items:</strong>
                          <ul style={{ margin: "4px 0 0 20px" }}>
                            {m.actionItems.map((a, i) => <li key={i}>{a}</li>)}
                          </ul>
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 11 }}>
                        msgId: {m.msgId} · type: {m.messageType} · extracted: {m.extractedAt ? new Date(m.extractedAt).toLocaleString() : "pending"}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {messages.length === 0 && !loading && <p className="muted">No messages yet.</p>}
      </div>
    </div>
  );
}
