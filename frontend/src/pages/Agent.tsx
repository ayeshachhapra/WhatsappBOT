import { useEffect, useMemo, useState } from "react";
import {
  AgentActionRecord,
  AgentDecision,
  AgentSettings,
  api,
  GroupRef,
} from "../api";

interface AgentStats {
  total: number;
  last24h: number;
  sent24h: number;
  byDecision: { _id: AgentDecision; count: number }[];
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

export default function Agent() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [actions, setActions] = useState<AgentActionRecord[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState<"" | AgentDecision>("");
  const [groupFilter, setGroupFilter] = useState("");

  async function loadAll() {
    const [s, t, a, st] = await Promise.all([
      api.get<{ settings: AgentSettings }>("/api/agent/settings"),
      api.get<{ groups: GroupRef[] }>("/api/groups/tracked"),
      api.get<{ actions: AgentActionRecord[] }>("/api/agent/actions"),
      api.get<AgentStats>("/api/agent/stats"),
    ]);
    setSettings(s.settings);
    setTracked(t.groups || []);
    setActions(a.actions);
    setStats(st);
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 15_000);
    return () => clearInterval(id);
  }, []);

  async function patchSettings(patch: Partial<AgentSettings>) {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const result = await api.put<{ settings: AgentSettings }>(
        "/api/agent/settings",
        patch
      );
      setSettings(result.settings);
    } catch (e: any) {
      alert("Save failed: " + e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  function toggleGroupAllowed(jid: string) {
    if (!settings) return;
    const next = settings.allowedGroupJids.includes(jid)
      ? settings.allowedGroupJids.filter((j) => j !== jid)
      : [...settings.allowedGroupJids, jid];
    patchSettings({ allowedGroupJids: next });
  }

  const visible = useMemo(() => {
    return actions.filter((a) => {
      if (decisionFilter && a.decision !== decisionFilter) return false;
      if (groupFilter && a.groupJid !== groupFilter) return false;
      return true;
    });
  }, [actions, decisionFilter, groupFilter]);

  const allowedSet = useMemo(
    () => new Set(settings?.allowedGroupJids || []),
    [settings?.allowedGroupJids]
  );

  if (!settings) {
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
      <p className="muted" style={{ marginBottom: 16 }}>
        An autonomous follow-up agent that reads incoming messages and chooses to
        ask clarifying questions, acknowledge clear updates, or escalate concerning
        ones. It can only send to groups you allowlist below.
      </p>

      {/* ── Stats strip ─────────────────────────── */}
      {stats && (
        <div className="alert-grid" style={{ marginBottom: 16 }}>
          <Stat label="Considered (24h)" value={stats.last24h} />
          <Stat
            label="Sent (24h)"
            value={stats.sent24h}
            tone={stats.sent24h > 0 ? "ok" : undefined}
          />
          {(["ask_clarifying", "acknowledge", "escalate", "none"] as AgentDecision[]).map(
            (d) => {
              const count =
                stats.byDecision.find((x) => x._id === d)?.count || 0;
              return (
                <Stat
                  key={d}
                  label={DECISION_LABEL[d]}
                  value={count}
                  tone={
                    d === "escalate" && count > 0
                      ? "danger"
                      : d === "acknowledge" && count > 0
                      ? "ok"
                      : d === "ask_clarifying" && count > 0
                      ? "warn"
                      : undefined
                  }
                />
              );
            }
          )}
        </div>
      )}

      {/* ── Settings card ────────────────────────── */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0 }}>Agent settings</h3>
          <label className="toggle" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={savingSettings}
              onChange={(e) => patchSettings({ enabled: e.target.checked })}
            />
            <span style={{ fontWeight: 500 }}>
              {settings.enabled ? "Agent ON" : "Agent OFF"}
            </span>
          </label>
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
            <label>Mode</label>
            <select
              value={settings.mode}
              disabled={savingSettings}
              onChange={(e) =>
                patchSettings({ mode: e.target.value as "active" | "observe" })
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
              value={settings.cooldownSeconds}
              disabled={savingSettings}
              onChange={(e) =>
                patchSettings({
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
              value={settings.maxMessagesPerGroupPerHour}
              disabled={savingSettings}
              onChange={(e) =>
                patchSettings({
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
              value={settings.maxMessagesPerGroupPerDay}
              disabled={savingSettings}
              onChange={(e) =>
                patchSettings({
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
            {tracked.map((g) => (
              <div key={g.jid} className="checkbox-row">
                <input
                  type="checkbox"
                  id={`agent-grp-${g.jid}`}
                  checked={allowedSet.has(g.jid)}
                  disabled={savingSettings || !settings.enabled}
                  onChange={() => toggleGroupAllowed(g.jid)}
                />
                <label htmlFor={`agent-grp-${g.jid}`}>{g.name}</label>
                {allowedSet.has(g.jid) && (
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
            ))}
          </div>
        )}
      </div>

      {/* ── Activity feed ────────────────────────── */}
      <div className="card">
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
          <h3 style={{ margin: 0 }}>Activity</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              value={decisionFilter}
              onChange={(e) =>
                setDecisionFilter(e.target.value as any)
              }
              style={{ minWidth: 160 }}
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
              style={{ minWidth: 160 }}
            >
              <option value="">All groups</option>
              {tracked.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>
            <button className="btn-secondary btn" onClick={loadAll}>
              Refresh
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>
            No agent activity yet. Enable the agent above and the next inbound
            message in an allowlisted group will show up here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visible.map((a) => (
              <ActionRow key={a._id} action={a} />
            ))}
          </div>
        )}
      </div>
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
          {action.error && (
            <Field label="Error" value={action.error} danger />
          )}
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
