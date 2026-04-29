import { useEffect, useMemo, useState } from "react";
import { api, MessageDoc, PurchaseOrder, PurchaseOrderStatus } from "../api";

const STATUS_COLOR: Record<PurchaseOrderStatus, string> = {
  delivered: "var(--accent)",
  in_transit: "var(--warn)",
  delayed: "var(--danger)",
  ordered: "var(--muted)",
  unknown: "var(--muted)",
};

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  delivered: "Delivered",
  in_transit: "In transit",
  delayed: "Delayed",
  ordered: "Ordered",
  unknown: "—",
};

interface DetailResponse {
  purchaseOrder: PurchaseOrder;
  messages: MessageDoc[];
}

export default function Browse() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | PurchaseOrderStatus>("");
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { orders } = await api.get<{ orders: PurchaseOrder[] }>(
        "/api/purchase-orders"
      );
      setPos(orders);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  async function openDetail(po: PurchaseOrder) {
    setDetailLoading(true);
    setDetail({ purchaseOrder: po, messages: [] });
    try {
      const data = await api.get<DetailResponse>(`/api/purchase-orders/${po._id}`);
      setDetail(data);
    } finally {
      setDetailLoading(false);
    }
  }

  async function reseedDemo() {
    if (
      !confirm(
        "Reseed demo data? This will delete all current purchase orders and replace them with the 10 demo rows."
      )
    )
      return;
    setSeeding(true);
    try {
      await api.post("/api/purchase-orders/seed-demo");
      await load();
    } finally {
      setSeeding(false);
    }
  }

  const visible = useMemo(() => {
    return pos.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (filter) {
        const f = filter.toLowerCase();
        if (
          !p.poNumber.toLowerCase().includes(f) &&
          !p.productName.toLowerCase().includes(f) &&
          !p.companyName.toLowerCase().includes(f)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [pos, filter, statusFilter]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: "0 0 6px" }}>Tracking</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            Master list of purchase orders. Each row is updated automatically as
            messages arrive in your tracked WhatsApp groups that mention the PO number.
          </p>
        </div>
        <button
          className="btn-secondary btn"
          onClick={reseedDemo}
          disabled={seeding}
          style={{ flex: 0, padding: "6px 14px", fontSize: 13 }}
        >
          {seeding ? "..." : "Reseed demo"}
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            placeholder="Filter by PO, product, or company..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
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

      {visible.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          No purchase orders match the filter.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Product</th>
                <th>Company</th>
                <th>ETA</th>
                <th>Status</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const etaDate = p.eta ? new Date(p.eta) : null;
                const overdue =
                  etaDate && etaDate.getTime() < Date.now() && p.status !== "delivered";
                return (
                  <tr key={p._id}>
                    <td>
                      <strong style={{ fontFamily: "monospace" }}>{p.poNumber}</strong>
                      {p.awaitingReply && (
                        <span
                          className="tag"
                          style={{
                            marginLeft: 6,
                            color: "var(--warn)",
                            borderColor: "var(--warn)",
                          }}
                          title="We sent a follow-up — supplier hasn't replied yet"
                        >
                          waiting reply
                        </span>
                      )}
                    </td>
                    <td>{p.productName}</td>
                    <td>{p.companyName}</td>
                    <td>
                      {etaDate ? (
                        <span style={{ color: overdue ? "var(--danger)" : undefined }}>
                          {etaDate.toLocaleDateString()}
                          {overdue && " (passed)"}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={{
                          background: `${STATUS_COLOR[p.status]}22`,
                          color: STATUS_COLOR[p.status],
                        }}
                      >
                        {STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn-secondary btn"
                        onClick={() => openDetail(p)}
                        style={{ padding: "4px 10px", fontSize: 12 }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <DetailModal
          detail={detail}
          loading={detailLoading}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            await load();
            if (detail) {
              const fresh = await api.get<DetailResponse>(
                `/api/purchase-orders/${detail.purchaseOrder._id}`
              );
              setDetail(fresh);
            }
          }}
        />
      )}
    </div>
  );
}

function DetailModal({
  detail,
  loading,
  onClose,
  onChanged,
}: {
  detail: DetailResponse;
  loading: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const po = detail.purchaseOrder;
  const [editing, setEditing] = useState(false);
  const [productName, setProductName] = useState(po.productName);
  const [companyName, setCompanyName] = useState(po.companyName);
  const [status, setStatus] = useState<PurchaseOrderStatus>(po.status);
  const [eta, setEta] = useState(po.eta ? po.eta.slice(0, 10) : "");
  const [notes, setNotes] = useState(po.notes || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProductName(po.productName);
    setCompanyName(po.companyName);
    setStatus(po.status);
    setEta(po.eta ? po.eta.slice(0, 10) : "");
    setNotes(po.notes || "");
  }, [po._id]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/purchase-orders/${po._id}`, {
        productName,
        companyName,
        status,
        eta: eta ? new Date(eta).toISOString() : null,
        notes: notes || null,
      });
      setEditing(false);
      await onChanged();
    } catch (e: any) {
      alert("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 720 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontFamily: "monospace" }}>{po.poNumber}</h3>
          <div style={{ display: "flex", gap: 8 }}>
            {!editing ? (
              <button
                className="btn-secondary btn"
                onClick={() => setEditing(true)}
                style={{ padding: "5px 12px", fontSize: 12 }}
              >
                Edit
              </button>
            ) : (
              <>
                <button
                  className="btn-secondary btn"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  onClick={save}
                  disabled={saving}
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  {saving ? "..." : "Save"}
                </button>
              </>
            )}
            <button
              className="btn-secondary btn"
              onClick={onClose}
              style={{ padding: "5px 12px", fontSize: 12 }}
            >
              Close
            </button>
          </div>
        </div>

        {!editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Product" value={po.productName} />
            <Field label="Company" value={po.companyName} />
            <Field
              label="ETA"
              value={po.eta ? new Date(po.eta).toLocaleDateString() : "—"}
            />
            <Field label="Status" value={STATUS_LABEL[po.status]} />
            <Field
              label="Awaiting reply"
              value={po.awaitingReply ? "Yes — we asked, no reply yet" : "No"}
            />
            <Field
              label="Last update"
              value={po.lastUpdateAt ? new Date(po.lastUpdateAt).toLocaleString() : "—"}
            />
            {po.notes && (
              <div style={{ gridColumn: "1 / span 2" }}>
                <Field label="Notes" value={po.notes} />
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label>Product</label>
              <input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
              />
            </div>
            <div>
              <label>Company</label>
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
            <div>
              <label>ETA</label>
              <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
            </div>
            <div>
              <label>Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as PurchaseOrderStatus)}
              >
                <option value="ordered">Ordered</option>
                <option value="in_transit">In transit</option>
                <option value="delayed">Delayed</option>
                <option value="delivered">Delivered</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
            <div style={{ gridColumn: "1 / span 2" }}>
              <label>Notes</label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        <h4 style={{ margin: "20px 0 8px" }}>Message timeline</h4>
        {loading ? (
          <div className="muted">Loading...</div>
        ) : detail.messages.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No messages mentioning {po.poNumber} yet. Once a tracked group sends a
            message containing this PO number, it'll appear here and update the row.
          </div>
        ) : (
          <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
            {detail.messages.map((m) => (
              <div
                key={m._id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div className="muted" style={{ fontSize: 11 }}>
                  {new Date(m.timestamp).toLocaleString()} ·{" "}
                  {m.fromMe ? (
                    <span style={{ color: "var(--accent)", fontWeight: 500 }}>You</span>
                  ) : (
                    m.sender
                  )}{" "}
                  · {m.groupName}
                </div>
                <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>
                  {m.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value}</div>
    </div>
  );
}
