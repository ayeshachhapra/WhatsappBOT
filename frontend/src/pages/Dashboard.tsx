import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, MessageDoc, PurchaseOrder, PurchaseOrderStatus } from "../api";

interface AlertsResponse {
  summary: {
    staleCount: number;
    negativeCount: number;
    quietCount: number;
    pendingDraftsCount: number;
    activeAutoChases: number;
    trackedGroupsCount: number;
    ruleTriggerCount: number;
    lateOrdersCount: number;
    upcomingOrdersCount: number;
  };
  staleActions: MessageDoc[];
  pendingDrafts: any[];
}

interface DashboardProps {
  embedded?: boolean;
}

type ViewKind = "late" | "not_reachable" | "ontrack";

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

export default function Dashboard({ embedded = false }: DashboardProps = {}) {
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [openAll, setOpenAll] = useState<ViewKind | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [alertsRes, posRes] = await Promise.all([
        api.get<AlertsResponse>("/api/alerts"),
        api.get<{ orders: PurchaseOrder[] }>("/api/purchase-orders"),
      ]);
      setAlerts(alertsRes);
      setPos(posRes.orders);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const { late, notReachable, ontrack } = useMemo(
    () => categorisePOs(pos),
    [pos]
  );

  if (!alerts && loading) {
    return (
      <div>
        {!embedded && <h2>Dashboard</h2>}
        <p className="muted">Loading...</p>
      </div>
    );
  }

  const s = alerts?.summary;

  return (
    <div>
      {!embedded && (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h2 style={{ margin: 0 }}>Dashboard</h2>
            <button className="btn-secondary btn" onClick={load} disabled={loading}>
              {loading ? "..." : "Refresh"}
            </button>
          </div>
          <p className="muted">
            Master view of tracked POs. Auto-refreshes every 30s as messages flow in.
          </p>
        </>
      )}

      <div className="alert-grid">
        <Stat
          label="Late orders"
          value={late.length}
          tone={late.length > 0 ? "danger" : undefined}
        />
        <Stat
          label="Not reachable"
          value={notReachable.length}
          tone={notReachable.length > 0 ? "warn" : undefined}
        />
        <Stat
          label="On track"
          value={ontrack.length}
          tone={ontrack.length > 0 ? "ok" : undefined}
        />
        <Stat
          label="Stale action items"
          value={s?.staleCount ?? 0}
          tone={(s?.staleCount ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          label="Pending follow-ups"
          value={s?.pendingDraftsCount ?? 0}
          tone={(s?.pendingDraftsCount ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          label="Active auto-chases"
          value={s?.activeAutoChases ?? 0}
          tone={(s?.activeAutoChases ?? 0) > 0 ? "ok" : undefined}
        />
      </div>

      <div className="view-grid">
        <ViewCard
          kind="late"
          title="⏰ Late orders"
          subtitle="Promised ETA already passed"
          orders={late}
          tone="danger"
          onOpenAll={() => setOpenAll("late")}
        />
        <ViewCard
          kind="not_reachable"
          title="📵 Not reachable"
          subtitle="We asked about ETA — no reply yet"
          orders={notReachable}
          tone="warn"
          onOpenAll={() => setOpenAll("not_reachable")}
        />
        <ViewCard
          kind="ontrack"
          title="✅ On track"
          subtitle="On schedule for delivery"
          orders={ontrack}
          tone="ok"
          onOpenAll={() => setOpenAll("ontrack")}
        />
      </div>

      {alerts && alerts.staleActions.length > 0 && (
        <Section title={`🟡 Stale action items (${alerts.staleActions.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Things that were promised or asked for, but haven't been resolved in 3+ days.
          </p>
          {alerts.staleActions.slice(0, 5).map((m) => (
            <div className="alert-card" key={m._id}>
              <div className="alert-head">
                <div>
                  <strong>{m.groupName}</strong>
                  <div className="alert-meta">
                    {new Date(m.timestamp).toLocaleString()} · {m.sender}
                    {m.topic && <> · <em>{m.topic}</em></>}
                  </div>
                </div>
              </div>
              {m.actionItems && m.actionItems.length > 0 && (
                <div className="alert-body">
                  {m.actionItems.map((a, i) => (
                    <div key={i}>• {a}</div>
                  ))}
                </div>
              )}
              <div className="muted" style={{ fontSize: 12 }}>
                "{truncate(m.body, 200)}"
              </div>
            </div>
          ))}
        </Section>
      )}

      {alerts && (s?.pendingDraftsCount ?? 0) > 0 && (
        <Section title={`📨 Pending follow-ups (${alerts.pendingDrafts.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Drafts waiting for your approval.
          </p>
          <Link to="/outbox" className="btn-secondary btn" style={{ display: "inline-block" }}>
            Review on Outbox tab →
          </Link>
        </Section>
      )}

      {pos.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 30 }}>
          <div style={{ fontSize: 36 }}>📦</div>
          <p style={{ margin: "10px 0 0" }}>
            No purchase orders yet. Add one in the{" "}
            <Link to="/browse">Tracking tab</Link>, or hit "Reseed demo" there to load the
            10 sample rows.
          </p>
        </div>
      )}

      {openAll && (
        <ViewModal
          kind={openAll}
          orders={
            openAll === "late" ? late : openAll === "not_reachable" ? notReachable : ontrack
          }
          onClose={() => setOpenAll(null)}
        />
      )}
    </div>
  );
}

function categorisePOs(pos: PurchaseOrder[]): {
  late: PurchaseOrder[];
  notReachable: PurchaseOrder[];
  ontrack: PurchaseOrder[];
} {
  const now = Date.now();
  const late: PurchaseOrder[] = [];
  const notReachable: PurchaseOrder[] = [];
  const ontrack: PurchaseOrder[] = [];

  for (const p of pos) {
    if (p.status === "delivered") continue;
    const etaMs = p.eta ? new Date(p.eta).getTime() : null;
    const isLate = p.status === "delayed" || (etaMs !== null && etaMs < now);

    if (isLate) {
      late.push(p);
    } else if (p.awaitingReply) {
      notReachable.push(p);
    } else if (
      p.status === "in_transit" ||
      (etaMs !== null && etaMs >= now && p.status === "ordered")
    ) {
      ontrack.push(p);
    }
  }

  late.sort((a, b) => etaMs(a) - etaMs(b));
  notReachable.sort((a, b) => lastUpdateMs(a) - lastUpdateMs(b));
  ontrack.sort((a, b) => etaMs(a) - etaMs(b));

  return { late, notReachable, ontrack };
}

function etaMs(p: PurchaseOrder): number {
  return p.eta ? new Date(p.eta).getTime() : Number.POSITIVE_INFINITY;
}

function lastUpdateMs(p: PurchaseOrder): number {
  return p.lastUpdateAt ? new Date(p.lastUpdateAt).getTime() : 0;
}

function ViewCard({
  title,
  subtitle,
  orders,
  tone,
  onOpenAll,
}: {
  kind: ViewKind;
  title: string;
  subtitle: string;
  orders: PurchaseOrder[];
  tone: "danger" | "warn" | "ok";
  onOpenAll: () => void;
}) {
  const top = orders.slice(0, 3);
  return (
    <div className={`view-card ${tone}`}>
      <div className="view-head">
        <div>
          <h3>
            {title}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              ({orders.length})
            </span>
          </h3>
          <div className="muted" style={{ fontSize: 12 }}>
            {subtitle}
          </div>
        </div>
        {orders.length > 3 && (
          <button
            className="btn-secondary btn"
            onClick={onOpenAll}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            Open all
          </button>
        )}
      </div>
      {top.length === 0 ? (
        <div className="view-empty">Nothing here.</div>
      ) : (
        <div className="view-list">
          {top.map((p) => (
            <PoRow key={p._id} po={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PoRow({ po }: { po: PurchaseOrder }) {
  const etaDate = po.eta ? new Date(po.eta) : null;
  const overdue =
    etaDate && etaDate.getTime() < Date.now() && po.status !== "delivered";
  return (
    <div className="view-row">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontFamily: "monospace", fontSize: 13 }}>{po.poNumber}</strong>
        <span
          className="status-badge"
          style={{
            background: `${STATUS_COLOR[po.status]}22`,
            color: STATUS_COLOR[po.status],
            fontSize: 11,
          }}
        >
          {STATUS_LABEL[po.status]}
        </span>
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>
        {po.productName}
        <span className="muted"> · {po.companyName}</span>
      </div>
      {etaDate && (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          ETA {etaDate.toLocaleDateString()}
          {overdue && (
            <span style={{ color: "var(--danger)", fontWeight: 500 }}> (passed)</span>
          )}
        </div>
      )}
      {po.lastUpdateAt && (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          Last update: {new Date(po.lastUpdateAt).toLocaleString()}
          {po.awaitingReply && " · awaiting supplier reply"}
        </div>
      )}
    </div>
  );
}

function ViewModal({
  kind,
  orders,
  onClose,
}: {
  kind: ViewKind;
  orders: PurchaseOrder[];
  onClose: () => void;
}) {
  const titles: Record<ViewKind, string> = {
    late: "Late orders",
    not_reachable: "Not reachable orders",
    ontrack: "On-track orders",
  };
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
            marginBottom: 14,
          }}
        >
          <h3 style={{ margin: 0 }}>
            {titles[kind]}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              ({orders.length})
            </span>
          </h3>
          <button
            className="btn-secondary btn"
            onClick={onClose}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            Close
          </button>
        </div>
        {orders.length === 0 ? (
          <div className="muted">Nothing here.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {orders.map((p) => (
              <PoRow key={p._id} po={p} />
            ))}
          </div>
        )}
        <div style={{ marginTop: 14, textAlign: "right" }}>
          <Link to="/browse" className="btn-secondary btn" onClick={onClose}>
            Open in Tracking →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className={`alert-stat ${tone || ""}`}>
      <div className="num">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ margin: "8px 0 12px" }}>{title}</h3>
      {children}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}
