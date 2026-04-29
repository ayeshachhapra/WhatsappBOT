import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, AlertTrigger, GroupRef, MessageDoc } from "../api";

interface QuietGroup {
  group: GroupRef;
  lastTimestamp: string | null;
  lastSender: string | null;
  lastBody: string | null;
  daysQuiet: number | null;
}

interface AutoChase {
  _id: string;
  name: string;
  messageText: string | null;
  targetGroups: GroupRef[];
  schedule: { times: string[]; days: number[] };
  enabled: boolean;
  stopOnResponse?: boolean;
  lastSentAt: string | null;
  sendCount: number;
}

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
  recentNegatives: MessageDoc[];
  quietGroups: QuietGroup[];
  pendingDrafts: any[];
  activeAutoChases: AutoChase[];
  ruleTriggers: AlertTrigger[];
  lateOrders: MessageDoc[];
  upcomingOrders: MessageDoc[];
}

interface DashboardProps {
  /** Hide the page heading + intro (use when embedded in another page). */
  embedded?: boolean;
}

export default function Dashboard({ embedded = false }: DashboardProps = {}) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<AlertsResponse>("/api/alerts");
      setData(res);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  async function chase(message: MessageDoc, draftText: string) {
    if (!confirm(`Save a follow-up draft for "${message.groupName}"?`)) return;
    setBusy({ ...busy, [message._id]: true });
    try {
      await api.post("/api/drafts", {
        draftText,
        targetGroups: [{ jid: message.groupJid, name: message.groupName }],
        label: `Chase: ${message.topic || message.body.substring(0, 40)}`,
        meta: {
          chatQuestion: `Auto-generated chase from dashboard for: ${message.topic || "—"}`,
          chatAnswerSnippet: message.body.substring(0, 300),
          triggerSender: message.sender,
        },
      });
      alert("Saved to Follow-ups → review on the Follow-ups tab.");
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setBusy({ ...busy, [message._id]: false });
    }
  }

  async function disableAutoChase(id: string, name: string) {
    if (!confirm(`Stop the auto-chase "${name}"?`)) return;
    try {
      await api.patch(`/api/schedules/${id}/toggle`, { enabled: false });
      await load();
    } catch (e: any) {
      alert("Failed: " + e.message);
    }
  }

  if (!data && loading) {
    return (
      <div>
        {!embedded && <h2>Dashboard</h2>}
        <p className="muted">Loading alerts...</p>
      </div>
    );
  }

  const s = data?.summary;
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
            Live view of issues that need your attention. Alerts auto-refresh every
            minute.
          </p>
        </>
      )}

      <div className="alert-grid">
        <Stat
          label="Rule triggers"
          value={s?.ruleTriggerCount ?? 0}
          tone={(s?.ruleTriggerCount ?? 0) > 0 ? "danger" : undefined}
        />
        <Stat
          label="Late orders"
          value={s?.lateOrdersCount ?? 0}
          tone={(s?.lateOrdersCount ?? 0) > 0 ? "danger" : undefined}
        />
        <Stat
          label="Upcoming (3 days)"
          value={s?.upcomingOrdersCount ?? 0}
          tone={(s?.upcomingOrdersCount ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          label="Stale action items"
          value={s?.staleCount ?? 0}
          tone={(s?.staleCount ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          label="Quiet groups"
          value={s?.quietCount ?? 0}
          tone={(s?.quietCount ?? 0) > 0 ? "warn" : undefined}
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

      {data && data.ruleTriggers.length > 0 && (
        <Section title={`🚨 Rule triggers (${data.ruleTriggers.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Your saved keyword rules matched these recent messages.{" "}
            <Link to="/rules">Manage rules →</Link>
          </p>
          {data.ruleTriggers.map((t) => (
            <div className="alert-card danger" key={t._id}>
              <div className="alert-head">
                <div>
                  <strong>{t.ruleName}</strong>
                  {t.matchedKeywords.map((k, i) => (
                    <span
                      key={i}
                      className="tag"
                      style={{ marginLeft: 4, color: "var(--danger)" }}
                    >
                      {k}
                    </span>
                  ))}
                  <div className="alert-meta">
                    {new Date(t.triggeredAt).toLocaleString()} · {t.groupName} · {t.sender}
                  </div>
                </div>
                <button
                  className="btn-secondary btn"
                  onClick={async () => {
                    await api.post(`/api/alert-triggers/${t._id}/ack`);
                    load();
                  }}
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  Ack
                </button>
              </div>
              <div className="alert-body">
                "{truncate(t.body, 250)}"
              </div>
            </div>
          ))}
        </Section>
      )}

      {data && data.lateOrders.length > 0 && (
        <Section title={`⏰ Late orders (${data.lateOrders.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Orders with a promised delivery date that's already passed without a confirmation.
          </p>
          {data.lateOrders.map((m) => (
            <div className="alert-card danger" key={m._id}>
              <div className="alert-head">
                <div>
                  <strong>
                    {(m.referenceNumbers || []).join(", ") || m.topic || m.groupName}
                  </strong>
                  <div className="alert-meta">
                    {m.groupName} · {m.sender}
                    {m.dueDate && (
                      <>
                        {" "}· ETA was{" "}
                        <strong style={{ color: "var(--danger)" }}>
                          {new Date(m.dueDate).toLocaleDateString()}
                        </strong>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="btn"
                  disabled={busy[m._id]}
                  onClick={() =>
                    chase(
                      m,
                      `Hi ${firstName(
                        m.sender
                      )}, the ETA on this was ${
                        m.dueDate
                          ? new Date(m.dueDate).toLocaleDateString()
                          : "earlier"
                      } — can you share the latest status please?`
                    )
                  }
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  {busy[m._id] ? "..." : "Chase"}
                </button>
              </div>
              <div className="alert-body">"{truncate(m.body, 250)}"</div>
            </div>
          ))}
        </Section>
      )}

      {data && data.upcomingOrders.length > 0 && (
        <Section title={`📅 Upcoming deliveries (${data.upcomingOrders.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            ETAs in the next 3 days. Worth keeping an eye on.
          </p>
          {data.upcomingOrders.map((m) => (
            <div className="alert-card info" key={m._id}>
              <div className="alert-head">
                <div>
                  <strong>
                    {(m.referenceNumbers || []).join(", ") || m.topic || m.groupName}
                  </strong>
                  <div className="alert-meta">
                    {m.groupName} · {m.sender}
                    {m.dueDate && (
                      <>
                        {" "}· ETA{" "}
                        <strong style={{ color: "var(--accent)" }}>
                          {new Date(m.dueDate).toLocaleDateString()}
                        </strong>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="alert-body">"{truncate(m.body, 250)}"</div>
            </div>
          ))}
        </Section>
      )}

      {data && (s?.staleCount ?? 0) > 0 && (
        <Section title={`🟡 Stale action items (${data.staleActions.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Things that were promised or asked for, but haven't been resolved in 3+ days.
          </p>
          {data.staleActions.map((m) => (
            <div className="alert-card" key={m._id}>
              <div className="alert-head">
                <div>
                  <strong>{m.groupName}</strong>
                  <div className="alert-meta">
                    {new Date(m.timestamp).toLocaleString()} · {m.sender}
                    {m.topic && <> · <em>{m.topic}</em></>}
                  </div>
                </div>
                <button
                  className="btn"
                  disabled={busy[m._id]}
                  onClick={() =>
                    chase(
                      m,
                      `Hi ${firstName(m.sender)}, just following up on this — any update?\n\n"${truncate(
                        m.body,
                        180
                      )}"`
                    )
                  }
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  {busy[m._id] ? "..." : "Save chase"}
                </button>
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

      {data && (s?.quietCount ?? 0) > 0 && (
        <Section title={`🟠 Quiet groups (${data.quietGroups.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Tracked groups with no messages in 2+ days. Worth a check-in.
          </p>
          {data.quietGroups.map((q) => (
            <div className="alert-card" key={q.group.jid}>
              <div className="alert-head">
                <div>
                  <strong>{q.group.name}</strong>
                  <div className="alert-meta">
                    {q.lastTimestamp
                      ? `Last activity ${q.daysQuiet} day(s) ago — ${new Date(
                          q.lastTimestamp
                        ).toLocaleString()}`
                      : "No messages captured yet"}
                    {q.lastSender && <> · {q.lastSender}</>}
                  </div>
                </div>
              </div>
              {q.lastBody && (
                <div className="muted" style={{ fontSize: 12 }}>
                  Last said: "{truncate(q.lastBody, 200)}"
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {data && (s?.pendingDraftsCount ?? 0) > 0 && (
        <Section title={`📨 Pending follow-ups (${data.pendingDrafts.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Drafts waiting for your approval.
          </p>
          <Link to="/followups" className="btn-secondary btn" style={{ display: "inline-block" }}>
            Review on Follow-ups tab →
          </Link>
        </Section>
      )}

      {data && data.activeAutoChases.length > 0 && (
        <Section title={`🔁 Active auto-chases (${data.activeAutoChases.length})`}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            These follow-ups send daily until the target group responds.
          </p>
          {data.activeAutoChases.map((c) => (
            <div className="alert-card info" key={c._id}>
              <div className="alert-head">
                <div>
                  <strong>{c.name}</strong>
                  <div className="alert-meta">
                    Daily at {c.schedule.times.join(", ")} · sent{" "}
                    {c.sendCount} time(s)
                    {c.lastSentAt && (
                      <> · last {new Date(c.lastSentAt).toLocaleString()}</>
                    )}
                  </div>
                </div>
                <button
                  className="btn-danger btn"
                  onClick={() => disableAutoChase(c._id, c.name)}
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  Stop
                </button>
              </div>
              {c.messageText && (
                <div className="alert-body">"{truncate(c.messageText, 200)}"</div>
              )}
              <div className="muted" style={{ fontSize: 12 }}>
                Targets: {c.targetGroups.map((g) => g.name).join(", ")}
              </div>
            </div>
          ))}
        </Section>
      )}

      {data &&
        data.ruleTriggers.length === 0 &&
        data.lateOrders.length === 0 &&
        data.upcomingOrders.length === 0 &&
        data.staleActions.length === 0 &&
        data.quietGroups.length === 0 &&
        data.pendingDrafts.length === 0 &&
        data.activeAutoChases.length === 0 && (
          <div className="card" style={{ textAlign: "center", padding: 30 }}>
            <div style={{ fontSize: 36 }}>✅</div>
            <p style={{ margin: "10px 0 0" }}>
              All clear. No stale items, no issues flagged, no quiet groups.
            </p>
            <p className="muted">
              Ask the AI a question on the <Link to="/chat">Ask AI</Link> tab.
            </p>
          </div>
        )}
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

function firstName(full: string): string {
  if (!full) return "there";
  return full.split(/\s+/)[0];
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}
