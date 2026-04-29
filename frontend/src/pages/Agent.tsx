import { useEffect, useMemo, useState } from "react";
import {
  AgentActionRecord,
  AgentDecision,
  AgentSettings,
  api,
  GroupRef,
} from "../api";

interface OpenThread {
  poNumber: string;
  productName: string;
  companyName: string;
  askedAt: string;
  supplierName: string;
  groupName: string;
  outboundText: string | null;
}

interface AgentSummary {
  enabled: boolean;
  mode: "active" | "observe";
  watchingGroupCount: number;
  last24h: number;
  sentLast24h: number;
  byDecision: { _id: AgentDecision; count: number }[];
  openThreads: OpenThread[];
  /** Threads where the agent has been waiting for a supplier reply > 4h. */
  atRiskCount: number;
  /** Threads the agent fully closed (asked → got answer → acknowledged) in 24h. */
  autoClosed24h: number;
  /** Average minutes between agent's clarifying question and the supplier's
   *  reply that closed the thread. Null when there's no data yet. */
  avgResolutionMinutes: number | null;
  /** Threads the agent escalated and not yet acknowledged by the human. */
  pendingEscalations: number;
}

const DECISION_LABEL: Record<AgentDecision, string> = {
  none: "Skipped",
  ask_clarifying: "Asked clarifying",
  acknowledge: "Acknowledged",
  escalate: "Escalated",
};

const DECISION_TONE: Record<AgentDecision, string> = {
  none: "var(--muted)",
  ask_clarifying: "var(--warn)",
  acknowledge: "var(--accent)",
  escalate: "var(--danger)",
};

const TOP_RECENT = 5;

export default function Agent() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [actions, setActions] = useState<AgentActionRecord[]>([]);
  const [summary, setSummary] = useState<AgentSummary | null>(null);

  // Activity filters / search
  const [decisionFilter, setDecisionFilter] = useState<"" | AgentDecision>("");
  const [groupFilter, setGroupFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  // Settings draft state — every edit lands in draftSettings; nothing is
  // persisted until the user hits "Save changes".
  const [draftSettings, setDraftSettings] = useState<AgentSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  async function loadAll() {
    const [s, t, a, sm] = await Promise.all([
      api.get<{ settings: AgentSettings }>("/api/agent/settings"),
      api.get<{ groups: GroupRef[] }>("/api/groups/tracked"),
      api.get<{ actions: AgentActionRecord[] }>("/api/agent/actions"),
      api.get<AgentSummary>("/api/agent/summary"),
    ]);
    setSettings(s.settings);
    // Only seed the draft on first load — don't clobber in-progress edits
    // when the auto-refresh ticker fires.
    setDraftSettings((prev) => (prev ? prev : s.settings));
    setTracked(t.groups || []);
    setActions(a.actions);
    setSummary(sm);
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 15_000);
    return () => clearInterval(id);
  }, []);

  const isDirty = useMemo(() => {
    if (!settings || !draftSettings) return false;
    return (
      settings.enabled !== draftSettings.enabled ||
      settings.mode !== draftSettings.mode ||
      settings.cooldownSeconds !== draftSettings.cooldownSeconds ||
      settings.maxMessagesPerGroupPerHour !==
        draftSettings.maxMessagesPerGroupPerHour ||
      settings.maxMessagesPerGroupPerDay !==
        draftSettings.maxMessagesPerGroupPerDay ||
      !arraysEqualUnordered(
        settings.allowedGroupJids,
        draftSettings.allowedGroupJids
      )
    );
  }, [settings, draftSettings]);

  async function saveSettings() {
    if (!draftSettings || !isDirty) return;
    setSavingSettings(true);
    try {
      const result = await api.put<{ settings: AgentSettings }>(
        "/api/agent/settings",
        {
          enabled: draftSettings.enabled,
          mode: draftSettings.mode,
          cooldownSeconds: draftSettings.cooldownSeconds,
          maxMessagesPerGroupPerHour: draftSettings.maxMessagesPerGroupPerHour,
          maxMessagesPerGroupPerDay: draftSettings.maxMessagesPerGroupPerDay,
          allowedGroupJids: draftSettings.allowedGroupJids,
        }
      );
      setSettings(result.settings);
      setDraftSettings(result.settings);
    } catch (e: any) {
      alert("Save failed: " + e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  function discardChanges() {
    if (settings) setDraftSettings(settings);
  }

  function patchDraft(patch: Partial<AgentSettings>) {
    setDraftSettings((d) => (d ? { ...d, ...patch } : d));
  }

  function toggleAllowedGroup(jid: string) {
    setDraftSettings((d) => {
      if (!d) return d;
      const next = d.allowedGroupJids.includes(jid)
        ? d.allowedGroupJids.filter((j) => j !== jid)
        : [...d.allowedGroupJids, jid];
      return { ...d, allowedGroupJids: next };
    });
  }

  // Apply filters + search to actions; keep the full sorted list for "see all".
  const filteredActions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return actions.filter((a) => {
      if (decisionFilter && a.decision !== decisionFilter) return false;
      if (groupFilter && a.groupJid !== groupFilter) return false;
      if (!q) return true;
      return (
        a.inboundBody.toLowerCase().includes(q) ||
        (a.outboundText || "").toLowerCase().includes(q) ||
        a.senderName.toLowerCase().includes(q) ||
        a.groupName.toLowerCase().includes(q) ||
        a.referenceNumbers.some((r) => r.toLowerCase().includes(q)) ||
        a.reasoning.toLowerCase().includes(q)
      );
    });
  }, [actions, decisionFilter, groupFilter, searchQuery]);

  const visibleActions = showAll
    ? filteredActions
    : filteredActions.slice(0, TOP_RECENT);

  if (!settings || !draftSettings) {
    return (
      <div>
        <h2 style={{ margin: 0 }}>AI Agent</h2>
        <p className="muted">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 6px" }}>AI Agent</h2>
      <p className="muted" style={{ marginBottom: 20 }}>
        An autonomous follow-up agent that reads incoming messages and chooses to
        ask clarifying questions, acknowledge clear updates, or escalate
        concerning ones.
      </p>

      {/* ── Agent summary ────────────────────────────────── */}
      <AgentSummaryCard summary={summary} settings={settings} />

      {/* ── Activity (top 5 by default) ───────────────── */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>Recent activity</h3>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {showAll
                ? `Showing all ${filteredActions.length} actions`
                : `Showing top ${Math.min(
                    TOP_RECENT,
                    filteredActions.length
                  )} of ${filteredActions.length}`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              placeholder="Search body, sender, group, ref..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ minWidth: 220, flex: 0 }}
            />
            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value as any)}
              style={{ minWidth: 160, flex: 0 }}
            >
              <option value="">All decisions</option>
              <option value="ask_clarifying">Asked clarifying</option>
              <option value="acknowledge">Acknowledged</option>
              <option value="escalate">Escalated</option>
              <option value="none">Skipped</option>
            </select>
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              style={{ minWidth: 160, flex: 0 }}
            >
              <option value="">All groups</option>
              {tracked.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {visibleActions.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>
            {actions.length === 0
              ? "No agent activity yet. Enable the agent below and the next inbound message in an allowlisted group will show up here."
              : "No actions match the current filters."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visibleActions.map((a) => (
              <ActionRow key={a._id} action={a} />
            ))}
          </div>
        )}

        {filteredActions.length > TOP_RECENT && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <button
              className="btn-secondary btn"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll
                ? `Show top ${TOP_RECENT} only`
                : `See all ${filteredActions.length} →`}
            </button>
          </div>
        )}
      </div>

      {/* ── Settings (last) ───────────────────────────── */}
      <div className="card" style={{ position: "relative" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>Agent settings</h3>
          {isDirty && (
            <span
              className="tag"
              style={{ color: "var(--warn)", borderColor: "var(--warn)" }}
            >
              unsaved changes
            </span>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginBottom: 16,
          }}
        >
          <div>
            <label>Agent state</label>
            <label className="toggle" style={{ cursor: "pointer", marginTop: 6 }}>
              <input
                type="checkbox"
                checked={draftSettings.enabled}
                onChange={(e) => patchDraft({ enabled: e.target.checked })}
              />
              <span style={{ fontWeight: 500 }}>
                {draftSettings.enabled ? "ON" : "OFF"}
              </span>
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Master switch. When off, no decisions are made or logged.
            </div>
          </div>
          <div>
            <label>Mode</label>
            <select
              value={draftSettings.mode}
              onChange={(e) =>
                patchDraft({ mode: e.target.value as "active" | "observe" })
              }
            >
              <option value="active">Active — decide & send</option>
              <option value="observe">
                Observe — log decisions, never send
              </option>
            </select>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Observe is useful while testing — every decision is recorded but no
              messages leave WhatsApp.
            </div>
          </div>
          <div>
            <label>Cooldown (seconds)</label>
            <input
              type="number"
              min={0}
              max={3600}
              value={draftSettings.cooldownSeconds}
              onChange={(e) =>
                patchDraft({
                  cooldownSeconds: parseInt(e.target.value) || 0,
                })
              }
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Minimum gap between agent messages in the same group.
            </div>
          </div>
          <div>
            <label>Hourly cap (per group)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={draftSettings.maxMessagesPerGroupPerHour}
              onChange={(e) =>
                patchDraft({
                  maxMessagesPerGroupPerHour: parseInt(e.target.value) || 0,
                })
              }
            />
          </div>
          <div>
            <label>Daily cap (per group)</label>
            <input
              type="number"
              min={0}
              max={1000}
              value={draftSettings.maxMessagesPerGroupPerDay}
              onChange={(e) =>
                patchDraft({
                  maxMessagesPerGroupPerDay: parseInt(e.target.value) || 0,
                })
              }
            />
          </div>
        </div>

        <h4 style={{ margin: "8px 0 8px" }}>Allowed groups</h4>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
          The agent can only send messages to these groups. Any group not on this
          list is read-only — even if a message there triggers a decision, no
          outbound is sent.
        </p>
        {tracked.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No tracked groups yet. Add some in Settings → Tracked Groups first.
          </div>
        ) : (
          <div className="checkbox-list">
            {tracked.map((g) => {
              const allowed = draftSettings.allowedGroupJids.includes(g.jid);
              return (
                <div key={g.jid} className="checkbox-row">
                  <input
                    type="checkbox"
                    id={`agent-grp-${g.jid}`}
                    checked={allowed}
                    onChange={() => toggleAllowedGroup(g.jid)}
                  />
                  <label htmlFor={`agent-grp-${g.jid}`}>{g.name}</label>
                  {allowed && (
                    <span
                      className="tag"
                      style={{
                        color: "var(--accent)",
                        borderColor: "var(--accent)",
                      }}
                    >
                      agent on
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Sticky-style action row at the bottom of the settings card */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            className="btn-secondary btn"
            onClick={discardChanges}
            disabled={!isDirty || savingSettings}
          >
            Discard
          </button>
          <button
            className="btn"
            onClick={saveSettings}
            disabled={!isDirty || savingSettings}
          >
            {savingSettings ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentSummaryCard({
  summary,
  settings,
}: {
  summary: AgentSummary | null;
  settings: AgentSettings;
}) {
  const status = !settings.enabled
    ? { label: "Off", tone: "var(--muted)" }
    : settings.mode === "observe"
    ? { label: "Observing", tone: "var(--warn)" }
    : { label: "Active", tone: "var(--accent)" };

  const openCount = summary?.openThreads.length ?? 0;
  const atRiskCount = summary?.atRiskCount ?? 0;
  const autoClosed = summary?.autoClosed24h ?? 0;
  const pendingEsc = summary?.pendingEscalations ?? 0;
  const avgMins = summary?.avgResolutionMinutes ?? null;
  const groupCount = settings.allowedGroupJids.length;

  let narrative = "";
  if (!settings.enabled) {
    narrative = "Agent is currently off. Toggle it on under Agent settings to start auto-replying.";
  } else if (groupCount === 0) {
    narrative = "Agent is on but no groups are allowlisted yet — add at least one under Agent settings → Allowed groups.";
  } else if (openCount > 0) {
    narrative = `Following up on ${openCount} open thread${openCount === 1 ? "" : "s"}. The agent is watching for replies — they'll close automatically.`;
  } else if ((summary?.last24h ?? 0) > 0) {
    narrative = "No open threads right now. The agent is watching for new messages.";
  } else {
    narrative = "Watching quietly — no inbound messages in tracked groups yet.";
  }

  return (
    <div className="agent-summary">
      {/* ── Status row + narrative ─────────────── */}
      <div className="agent-summary__head">
        <div className="agent-summary__status">
          <span
            className="agent-summary__dot"
            style={{ background: status.tone }}
          />
          <span
            className="agent-summary__status-label"
            style={{ color: status.tone }}
          >
            {status.label}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            · {groupCount} group{groupCount === 1 ? "" : "s"} watched
          </span>
        </div>
        <p className="agent-summary__narrative">{narrative}</p>
      </div>

      {/* ── Mini stats — chosen for SCM buyer relevance:
            - Open threads   : how many active follow-ups to keep an eye on
            - At risk (>4h)  : suppliers ignoring the agent — needs nudging
            - Auto-closed    : threads the agent fully resolved without you
            - Avg close time : supplier responsiveness signal
            - Pending escalations: things the AGENT thought you should look at
       ────────────────────────────────────────────── */}
      <div className="agent-summary__stats">
        <SummaryMini
          label="Open threads"
          value={String(openCount)}
          accent={openCount > 0}
          hint="Suppliers haven't replied yet"
        />
        <SummaryMini
          label="At risk (>4h)"
          value={String(atRiskCount)}
          danger={atRiskCount > 0}
          hint="Waiting on supplier > 4 hours"
        />
        <SummaryMini
          label="Auto-closed (24h)"
          value={String(autoClosed)}
          accent={autoClosed > 0}
          hint="Resolved without your input"
        />
        <SummaryMini
          label="Avg time to close"
          value={
            avgMins == null
              ? "—"
              : avgMins < 60
              ? `${avgMins}m`
              : `${(avgMins / 60).toFixed(1)}h`
          }
          hint="Supplier responsiveness"
        />
        <SummaryMini
          label="Needs your review"
          value={String(pendingEsc)}
          danger={pendingEsc > 0}
          hint="Agent escalated — open in Activity"
        />
      </div>

      {/* ── Open thread list ─────────────────── */}
      {summary && summary.openThreads.length > 0 && (
        <div className="agent-summary__threads">
          <div className="agent-summary__threads-title">
            Currently following up on
          </div>
          <div className="agent-summary__threads-list">
            {summary.openThreads.slice(0, 6).map((t) => (
              <div className="agent-thread" key={t.poNumber + t.askedAt}>
                <div className="agent-thread__main">
                  <span className="agent-thread__po">{t.poNumber}</span>
                  <span className="agent-thread__product">{t.productName}</span>
                </div>
                <div className="agent-thread__meta muted">
                  asked {t.supplierName} · {t.companyName}
                </div>
                <div className="agent-thread__when muted">
                  {timeAgo(t.askedAt)}
                </div>
              </div>
            ))}
          </div>
          {summary.openThreads.length > 6 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              +{summary.openThreads.length - 6} more open thread
              {summary.openThreads.length - 6 === 1 ? "" : "s"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryMini({
  label,
  value,
  accent,
  danger,
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <div className="agent-summary__stat" title={hint}>
      <div
        className="agent-summary__stat-num"
        style={{
          color: danger
            ? "var(--danger)"
            : accent
            ? "var(--accent)"
            : "var(--text)",
        }}
      >
        {value}
      </div>
      <div className="agent-summary__stat-label">{label}</div>
      {hint && <div className="agent-summary__stat-hint">{hint}</div>}
    </div>
  );
}

function ActionRow({ action }: { action: AgentActionRecord }) {
  const [expanded, setExpanded] = useState(false);
  const tone = DECISION_TONE[action.decision];
  return (
    <div
      className="alert-card"
      style={{ borderLeftColor: tone, cursor: "pointer" }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="alert-head">
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              className="status-badge"
              style={{
                background: `${tone}22`,
                color: tone,
                fontSize: 11,
              }}
            >
              {DECISION_LABEL[action.decision]}
            </span>
            {action.sent ? (
              <span
                className="tag"
                style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
              >
                sent
              </span>
            ) : action.skipReason ? (
              <span
                className="tag"
                style={{ color: "var(--muted)" }}
                title={action.skipReason}
              >
                skipped: {action.skipReason}
              </span>
            ) : null}
            {action.referenceNumbers.map((r) => (
              <span key={r} className="tag" style={{ fontFamily: "monospace" }}>
                {r}
              </span>
            ))}
          </div>
          <div className="alert-meta" style={{ marginTop: 4 }}>
            {new Date(action.consideredAt).toLocaleString()} · {action.groupName}{" "}
            · from {action.senderName}
          </div>
        </div>
        <span className="muted" style={{ fontSize: 18 }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      <div
        className="muted"
        style={{ fontSize: 13, fontStyle: "italic", marginTop: 6 }}
      >
        {action.reasoning || "(no reasoning recorded)"}
      </div>

      {expanded && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <Field label="Inbound" value={action.inboundBody} mono />
          {action.outboundText && (
            <Field label="Outbound" value={action.outboundText} mono accent />
          )}
          {action.mentionName && (
            <Field
              label="Mention"
              value={`@${action.mentionName} (${action.mentionJid})`}
              mono
            />
          )}
          {action.error && <Field label="Error" value={action.error} danger />}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  accent,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 13,
          whiteSpace: "pre-wrap",
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          color: danger ? "var(--danger)" : accent ? "var(--accent)" : undefined,
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

function arraysEqualUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
