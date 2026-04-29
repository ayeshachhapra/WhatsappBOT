import { useEffect, useMemo, useState } from "react";
import { api, DraftDoc } from "../api";

type StatusFilter = "" | "pending" | "sent" | "rejected" | "approved";
type SourceFilter = "" | "manual" | "schedule";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  sent: "Sent",
  rejected: "Rejected",
  approved: "Approved",
};

const STATUS_TONE: Record<string, string> = {
  pending: "qr_ready",
  sent: "ready",
  rejected: "disconnected",
  approved: "qr_ready",
};

export default function Followups() {
  const [drafts, setDrafts] = useState<DraftDoc[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const { drafts } = await api.get<{ drafts: DraftDoc[] }>(
        "/api/drafts?" + params.toString()
      );
      setDrafts(drafts);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [statusFilter]);

  const visible = useMemo(() => {
    return sourceFilter
      ? drafts.filter((d) => d.source === sourceFilter)
      : drafts;
  }, [drafts, sourceFilter]);

  const stats = useMemo(() => {
    return {
      total: drafts.length,
      pending: drafts.filter((d) => d.status === "pending").length,
      sent: drafts.filter((d) => d.status === "sent").length,
      manual: drafts.filter((d) => d.source === "manual").length,
    };
  }, [drafts]);

  async function approve(d: DraftDoc) {
    if (!confirm(`Send to ${d.targetGroups.length} group(s)?`)) return;
    setBusy({ ...busy, [d._id]: true });
    try {
      const text = edits[d._id];
      if (text && text !== d.draftText) {
        await api.put(`/api/drafts/${d._id}`, { draftText: text });
      }
      await api.post(`/api/drafts/${d._id}/approve`);
      await load();
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setBusy({ ...busy, [d._id]: false });
    }
  }

  async function reject(d: DraftDoc) {
    if (!confirm("Reject this follow-up?")) return;
    setBusy({ ...busy, [d._id]: true });
    try {
      await api.post(`/api/drafts/${d._id}/reject`);
      await load();
    } finally {
      setBusy({ ...busy, [d._id]: false });
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        AI-suggested and scheduled follow-ups — review, approve, or look back at sent ones.
      </p>

      <div className="card" style={{ display: "flex", gap: 16 }}>
        <Stat label="Total" value={stats.total} />
        <Stat label="Pending" value={stats.pending} tone="warn" />
        <Stat label="Sent" value={stats.sent} tone="ok" />
        <Stat label="From chat" value={stats.manual} />
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <div style={{ flex: 0, minWidth: 160 }}>
            <label>Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="rejected">Rejected</option>
              <option value="approved">Approved (failed send)</option>
            </select>
          </div>
          <div style={{ flex: 0, minWidth: 160 }}>
            <label>Source</label>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            >
              <option value="">All</option>
              <option value="manual">From Ask AI</option>
              <option value="schedule">From a schedule</option>
            </select>
          </div>
          <div style={{ flex: 0, alignSelf: "end" }}>
            <button className="btn-secondary btn" onClick={load} disabled={loading}>
              {loading ? "..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="muted">No follow-ups match these filters.</div>
      )}

      {visible.map((d) => (
        <FollowupCard
          key={d._id}
          draft={d}
          edits={edits}
          setEdits={setEdits}
          busy={!!busy[d._id]}
          onApprove={() => approve(d)}
          onReject={() => reject(d)}
        />
      ))}
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
  tone?: "ok" | "warn";
}) {
  const color =
    tone === "ok" ? "var(--accent)" : tone === "warn" ? "var(--warn)" : "var(--text)";
  return (
    <div style={{ flex: 1, textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 600, color }}>{value}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );
}

function FollowupCard({
  draft,
  edits,
  setEdits,
  busy,
  onApprove,
  onReject,
}: {
  draft: DraftDoc;
  edits: Record<string, string>;
  setEdits: (e: Record<string, string>) => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isPending = draft.status === "pending";
  const isManual = draft.source === "manual";
  const tone = STATUS_TONE[draft.status] || "disconnected";

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{draft.scheduleName}</strong>
            <span className={`status-badge status-${tone}`}>
              {STATUS_LABELS[draft.status] || draft.status}
            </span>
            <span className="tag">{isManual ? "from Ask AI" : "from schedule"}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Created {new Date(draft.createdAt).toLocaleString()}
            {draft.sentAt && (
              <> · Sent {new Date(draft.sentAt).toLocaleString()}</>
            )}
            {draft.decidedAt && !draft.sentAt && (
              <> · Decided {new Date(draft.decidedAt).toLocaleString()}</>
            )}
          </div>
        </div>
      </div>

      {draft.meta?.chatQuestion && (
        <div className="meta-block">
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            ORIGINAL QUESTION
          </div>
          <div>{draft.meta.chatQuestion}</div>
          {draft.meta.chatAnswerSnippet && (
            <>
              <div className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 2 }}>
                AI ANSWER (excerpt)
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {draft.meta.chatAnswerSnippet}
              </div>
            </>
          )}
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Targets: {draft.targetGroups.map((g) => g.name).join(", ")}
        {draft.meta?.triggerSender && (
          <> · addressed to <strong>{draft.meta.triggerSender}</strong></>
        )}
      </div>

      {isPending ? (
        <textarea
          rows={4}
          value={edits[draft._id] ?? draft.draftText}
          onChange={(e) => setEdits({ ...edits, [draft._id]: e.target.value })}
        />
      ) : (
        <div
          style={{
            background: "var(--panel-2)",
            padding: 12,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            border: "1px solid var(--border)",
          }}
        >
          {draft.draftText}
        </div>
      )}

      {draft.sendError && (
        <div style={{ color: "var(--danger)", marginTop: 8, fontSize: 13 }}>
          Send error: {draft.sendError}
        </div>
      )}

      {isPending && (
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button className="btn" onClick={onApprove} disabled={busy}>
            {busy ? "Sending..." : "Approve & Send"}
          </button>
          <button className="btn-danger btn" onClick={onReject} disabled={busy}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
