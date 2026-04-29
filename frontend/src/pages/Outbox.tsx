import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  GroupRef,
  OutboxItem,
  OutboxSource,
  OutboxStats,
  OutboxStatus,
} from "../api";

const SOURCE_LABEL: Record<OutboxSource, string> = {
  ai_chat: "Ask AI",
  schedule: "Schedule",
  agent: "Agent",
};

const SOURCE_ICON: Record<OutboxSource, string> = {
  ai_chat: "💬",
  schedule: "⏰",
  agent: "✨",
};

const SOURCE_TONE: Record<OutboxSource, string> = {
  ai_chat: "var(--accent)",
  schedule: "var(--muted)",
  agent: "var(--warn)",
};

const STATUS_LABEL: Record<OutboxStatus, string> = {
  pending: "Pending review",
  sent: "Sent",
  rejected: "Rejected",
  approved: "Approved",
  failed: "Failed",
};

const STATUS_TONE: Record<OutboxStatus, string> = {
  pending: "var(--warn)",
  sent: "var(--accent)",
  rejected: "var(--muted)",
  approved: "var(--accent)",
  failed: "var(--danger)",
};

export default function Outbox() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [loading, setLoading] = useState(false);

  // Filters
  const [sourceFilter, setSourceFilter] = useState<"" | OutboxSource>("");
  const [statusFilter, setStatusFilter] = useState<"" | OutboxStatus>("");
  const [groupFilter, setGroupFilter] = useState("");
  const [search, setSearch] = useState("");

  // Inline edit state for pending drafts
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sourceFilter) params.set("source", sourceFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (groupFilter) params.set("groupJid", groupFilter);
      if (search.trim()) params.set("q", search.trim());
      const [t, s, g] = await Promise.all([
        api.get<{ items: OutboxItem[] }>("/api/outbox/timeline?" + params.toString()),
        api.get<OutboxStats>("/api/outbox/stats"),
        api.get<{ groups: GroupRef[] }>("/api/groups/tracked"),
      ]);
      setItems(t.items);
      setStats(s);
      setTracked(g.groups || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
    // Re-fetch on filter change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, statusFilter, groupFilter, search]);

  // Pending drafts surface separately at the top.
  const { pending, history } = useMemo(() => {
    const pend = items.filter((i) => i.status === "pending");
    const hist = items.filter((i) => i.status !== "pending");
    return { pending: pend, history: hist };
  }, [items]);

  const hasActiveFilters =
    !!sourceFilter || !!statusFilter || !!groupFilter || !!search.trim();

  function clearFilters() {
    setSourceFilter("");
    setStatusFilter("");
    setGroupFilter("");
    setSearch("");
  }

  async function approve(item: OutboxItem) {
    if (!item.draftId) return;
    if (!confirm(`Send to ${item.targetGroups.map((g) => g.name).join(", ")}?`)) return;
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      const editedText = edits[item.id];
      if (editedText && editedText !== item.text) {
        await api.put(`/api/drafts/${item.draftId}`, { draftText: editedText });
      }
      await api.post(`/api/drafts/${item.draftId}/approve`);
      await load();
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }

  async function reject(item: OutboxItem) {
    if (!item.draftId) return;
    if (!confirm("Reject this follow-up?")) return;
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      await api.post(`/api/drafts/${item.draftId}/reject`);
      await load();
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <div>
          <h2 style={{ margin: "0 0 6px" }}>Outbox</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Every message sent by this system — drafted from chat, sent by the
            agent, or fired by a schedule.
          </p>
        </div>
        <Link to="/schedules" className="btn-secondary btn">
          Manage schedules →
        </Link>
      </div>

      {/* ── KPI strip ───────────────────────────────────── */}
      {stats && (
        <div className="alert-grid" style={{ marginTop: 16, marginBottom: 16 }}>
          <Stat
            label="Pending review"
            value={stats.pendingReview}
            tone={stats.pendingReview > 0 ? "warn" : undefined}
          />
          <Stat
            label="Sent today"
            value={stats.sentToday}
            tone={stats.sentToday > 0 ? "ok" : undefined}
          />
          <Stat
            label="Agent (24h)"
            value={stats.agentAuto24h}
            tone={stats.agentAuto24h > 0 ? "ok" : undefined}
          />
          <Stat
            label="Failed"
            value={stats.failed}
            tone={stats.failed > 0 ? "danger" : undefined}
          />
        </div>
      )}

      {/* ── Filter row ──────────────────────────────────── */}
      <div className="card" style={{ padding: 12 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            placeholder="Search text, sender, group, ref..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as any)}
            style={{ flex: 0, minWidth: 150 }}
          >
            <option value="">All sources</option>
            <option value="ai_chat">💬 Ask AI</option>
            <option value="agent">✨ Agent</option>
            <option value="schedule">⏰ Schedule</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            style={{ flex: 0, minWidth: 150 }}
          >
            <option value="">All status</option>
            <option value="pending">Pending review</option>
            <option value="sent">Sent</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </select>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            style={{ flex: 0, minWidth: 150 }}
          >
            <option value="">All groups</option>
            {tracked.map((g) => (
              <option key={g.jid} value={g.jid}>
                {g.name}
              </option>
            ))}
          </select>
          {hasActiveFilters && (
            <button
              className="btn-secondary btn"
              onClick={clearFilters}
              style={{ flex: 0 }}
              title="Reset all filters"
            >
              Clear filters
            </button>
          )}
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

      {/* ── Pending review (always pinned at top) ───────── */}
      {pending.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <SectionTitle
            label="Pending review"
            count={pending.length}
            tone="var(--warn)"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {pending.map((item) => (
              <OutboxRow
                key={item.id}
                item={item}
                editable
                editValue={edits[item.id]}
                onEditChange={(v) => setEdits((e) => ({ ...e, [item.id]: v }))}
                busy={!!busy[item.id]}
                onApprove={() => approve(item)}
                onReject={() => reject(item)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── History (everything else) ───────────────────── */}
      <div style={{ marginTop: 18 }}>
        <SectionTitle label="Activity" count={history.length} />
        {history.length === 0 ? (
          <div
            className="muted"
            style={{
              padding: 20,
              textAlign: "center",
              background: "var(--panel-2)",
              borderRadius: 8,
              border: "1px dashed var(--border)",
            }}
          >
            {hasActiveFilters ? (
              <>
                <div style={{ fontSize: 14, marginBottom: 6 }}>
                  No messages match your current filters.
                </div>
                <button
                  className="btn-secondary btn"
                  onClick={clearFilters}
                  style={{ padding: "6px 14px", fontSize: 12 }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14, marginBottom: 4 }}>
                  No outbound messages yet.
                </div>
                <div style={{ fontSize: 12 }}>
                  Approve a draft from{" "}
                  <Link to="/chat">Ask AI</Link> or enable the{" "}
                  <Link to="/agent">Agent</Link> to start.
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {history.map((item) => (
              <OutboxRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionTitle({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone?: string;
}) {
  return (
    <div className="outbox-section-title">
      <span style={{ color: tone || "var(--muted)" }}>{label}</span>
      <span className="outbox-section-count">{count}</span>
    </div>
  );
}

function OutboxRow({
  item,
  editable,
  editValue,
  onEditChange,
  busy,
  onApprove,
  onReject,
}: {
  item: OutboxItem;
  editable?: boolean;
  editValue?: string;
  onEditChange?: (v: string) => void;
  busy?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceTone = SOURCE_TONE[item.source];
  const statusTone = STATUS_TONE[item.status];
  const text = editable ? editValue ?? item.text : item.text;

  const hasContextDetail =
    !!item.chatQuestion ||
    !!item.reasoning ||
    !!item.error ||
    !!item.mentionName;

  return (
    <div className="outbox-row" style={{ borderLeftColor: sourceTone }}>
      <div className="outbox-row__head">
        <div className="outbox-row__chips">
          <span
            className="outbox-row__source"
            style={{ color: sourceTone, borderColor: sourceTone + "55" }}
          >
            {SOURCE_ICON[item.source]} {SOURCE_LABEL[item.source]}
          </span>
          <span
            className="status-badge"
            style={{
              background: `${statusTone}22`,
              color: statusTone,
              fontSize: 11,
            }}
          >
            {STATUS_LABEL[item.status]}
          </span>
          {item.refs.map((r) => (
            <span key={r} className="outbox-row__ref">{r}</span>
          ))}
        </div>
        <div className="outbox-row__meta muted">
          {item.sentAt
            ? `Sent ${timeAgo(item.sentAt)}`
            : `Drafted ${timeAgo(item.createdAt)}`}
        </div>
      </div>

      <div className="outbox-row__targets muted">
        {item.targetGroups.map((g) => g.name).join(", ")}
        {item.triggerSender && (
          <>
            {" "}· addressed to <strong>{item.triggerSender}</strong>
          </>
        )}
      </div>

      {editable ? (
        <textarea
          rows={3}
          value={text}
          onChange={(e) => onEditChange?.(e.target.value)}
          style={{ marginTop: 4 }}
        />
      ) : (
        <div className="outbox-row__body">{item.text}</div>
      )}

      {hasContextDetail && (
        <button
          className="outbox-row__expand"
          onClick={() => setExpanded((s) => !s)}
        >
          {expanded ? "▾ Hide details" : "▸ Show details"}
        </button>
      )}

      {expanded && hasContextDetail && (
        <div className="outbox-row__detail">
          {item.reasoning && (
            <DetailField label="Why this was sent" value={item.reasoning} />
          )}
          {item.chatQuestion && (
            <DetailField
              label="Original question"
              value={item.chatQuestion}
            />
          )}
          {item.chatAnswerSnippet && (
            <DetailField
              label="AI answer (excerpt)"
              value={item.chatAnswerSnippet}
            />
          )}
          {item.mentionName && (
            <DetailField
              label="Tagged"
              value={`@${item.mentionName} (${item.mentionJid})`}
              mono
            />
          )}
          {item.error && (
            <DetailField label="Error" value={item.error} danger />
          )}
        </div>
      )}

      {editable && (
        <div className="outbox-row__actions">
          <button
            className="btn-danger btn"
            onClick={onReject}
            disabled={busy}
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            Reject
          </button>
          <button
            className="btn"
            onClick={onApprove}
            disabled={busy}
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            {busy ? "Sending..." : "Approve & send"}
          </button>
        </div>
      )}
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: danger ? "var(--danger)" : undefined,
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          marginTop: 2,
          whiteSpace: "pre-wrap",
        }}
      >
        {value}
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

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
