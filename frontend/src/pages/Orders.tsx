import { useEffect, useState } from "react";
import { api, MessageDoc, OrderSummary } from "../api";

const STATUS_COLOR: Record<string, string> = {
  delivered: "var(--accent)",
  in_transit: "var(--warn)",
  delayed: "var(--danger)",
  ordered: "var(--muted)",
  unknown: "var(--muted)",
};

const STATUS_LABEL: Record<string, string> = {
  delivered: "Delivered",
  in_transit: "In transit",
  delayed: "Delayed",
  ordered: "Ordered",
  unknown: "—",
};

export default function Orders() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { orders } = await api.get<{ orders: OrderSummary[] }>("/api/orders");
      setOrders(orders);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function open(ref: string) {
    setSelected(ref);
    setMessages([]);
    setMsgsLoading(true);
    try {
      const { messages } = await api.get<{ messages: MessageDoc[] }>(
        "/api/orders/" + encodeURIComponent(ref)
      );
      setMessages(messages);
    } finally {
      setMsgsLoading(false);
    }
  }

  const visible = orders.filter((o) => {
    if (statusFilter && o.status !== statusFilter) return false;
    if (filter) {
      const f = filter.toLowerCase();
      if (
        !o.ref.toLowerCase().includes(f) &&
        !o.groups.some((g) => g.name.toLowerCase().includes(f)) &&
        !o.senders.some((s) => s.toLowerCase().includes(f))
      ) {
        return false;
      }
    }
    return true;
  });

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Every PO / AWB / invoice number mentioned in tracked groups, with computed status.
      </p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            placeholder="Filter by reference, group, or sender..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ flex: 0, minWidth: 140 }}
          >
            <option value="">All statuses</option>
            <option value="ordered">Ordered</option>
            <option value="in_transit">In transit</option>
            <option value="delayed">Delayed</option>
            <option value="delivered">Delivered</option>
            <option value="unknown">Unknown</option>
          </select>
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
          No orders detected yet. Once messages with PO/AWB/invoice numbers arrive,
          they'll group here automatically.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          {visible.map((o) => (
            <div
              key={o.ref}
              className="card"
              style={{
                cursor: "pointer",
                borderColor: selected === o.ref ? "var(--accent)" : undefined,
                borderLeft: `4px solid ${STATUS_COLOR[o.status]}`,
              }}
              onClick={() => open(o.ref)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <strong style={{ fontSize: 16, fontFamily: "monospace" }}>{o.ref}</strong>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {o.count} mention{o.count !== 1 ? "s" : ""} · {o.groups.length} group(s) · {o.senders.length} sender(s)
                  </div>
                </div>
                <span
                  className="status-badge"
                  style={{
                    background: `${STATUS_COLOR[o.status]}22`,
                    color: STATUS_COLOR[o.status],
                  }}
                >
                  {STATUS_LABEL[o.status]}
                </span>
              </div>
              {o.dueDate && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  📅 ETA: {new Date(o.dueDate).toLocaleDateString()}{" "}
                  {new Date(o.dueDate).getTime() < Date.now() && (
                    <span style={{ color: "var(--danger)", fontWeight: 500 }}>
                      (passed)
                    </span>
                  )}
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Last: {new Date(o.lastAt).toLocaleString()}
              </div>
              {o.lastBody && (
                <div
                  className="muted"
                  style={{ fontSize: 12, marginTop: 4, fontStyle: "italic" }}
                >
                  "{o.lastBody.substring(0, 150)}"
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          {selected ? (
            <div className="card" style={{ position: "sticky", top: 0 }}>
              <h3 style={{ margin: "0 0 12px", fontFamily: "monospace" }}>{selected}</h3>
              {msgsLoading ? (
                <div className="muted">Loading...</div>
              ) : messages.length === 0 ? (
                <div className="muted">No messages found.</div>
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
                        {m.bodySource === "ocr" && (
                          <span className="tag" style={{ marginLeft: 6 }}>OCR</span>
                        )}
                        {m.dueDate && (
                          <>
                            {" "}· 📅 {new Date(m.dueDate).toLocaleDateString()}
                          </>
                        )}
                      </div>
                      <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>
                        {m.body}
                      </div>
                      {m.actionItems && m.actionItems.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          {m.actionItems.map((a, i) => (
                            <div key={i} className="muted" style={{ fontSize: 12 }}>
                              → {a}
                            </div>
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
              Click an order to see its full timeline.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
