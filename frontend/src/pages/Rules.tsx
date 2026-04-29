import { useEffect, useState } from "react";
import { api, AlertRule, AlertTrigger, GroupRef } from "../api";
import GroupPicker from "../components/GroupPicker";

const SUGGESTED: { name: string; keywords: string[] }[] = [
  { name: "Delays", keywords: ["delayed", "delay", "late", "postponed", "pushed"] },
  { name: "Cancellations", keywords: ["cancelled", "canceled", "cancel"] },
  { name: "Damage / shortages", keywords: ["damaged", "broken", "short", "shortage", "missing"] },
  { name: "Customs / hold", keywords: ["customs", "held up", "stuck", "hold", "clearance"] },
  { name: "Payment chase", keywords: ["payment", "invoice", "outstanding", "pending payment"] },
];

interface RulesProps {
  embedded?: boolean;
}

export default function Rules({ embedded = false }: RulesProps = {}) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [triggers, setTriggers] = useState<AlertTrigger[]>([]);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [form, setForm] = useState<{
    name: string;
    keywordsText: string;
    groups: GroupRef[];
    enabled: boolean;
  }>({ name: "", keywordsText: "", groups: [], enabled: true });
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const [{ rules }, { triggers }, { groups }] = await Promise.all([
        api.get<{ rules: AlertRule[] }>("/api/alert-rules"),
        api.get<{ triggers: AlertTrigger[] }>(
          "/api/alert-triggers?acknowledged=false"
        ),
        api.get<{ groups: GroupRef[] }>("/api/groups/tracked"),
      ]);
      setRules(rules);
      setTriggers(triggers);
      setTracked(groups);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startNew(suggestion?: { name: string; keywords: string[] }) {
    setEditing(null);
    setForm({
      name: suggestion?.name || "",
      keywordsText: suggestion?.keywords.join(", ") || "",
      groups: [],
      enabled: true,
    });
    setShowForm(true);
  }

  function startEdit(r: AlertRule) {
    setEditing(r);
    setForm({
      name: r.name,
      keywordsText: r.keywords.join(", "),
      groups: tracked.filter((g) => r.groupJids.includes(g.jid)),
      enabled: r.enabled,
    });
    setShowForm(true);
  }

  async function save() {
    setErr(null);
    try {
      const keywords = form.keywordsText
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const body = {
        name: form.name,
        keywords,
        groupJids: form.groups.map((g) => g.jid),
        enabled: form.enabled,
      };
      if (editing) {
        await api.put(`/api/alert-rules/${editing._id}`, body);
      } else {
        await api.post("/api/alert-rules", body);
      }
      setShowForm(false);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function toggle(r: AlertRule) {
    await api.patch(`/api/alert-rules/${r._id}/toggle`, { enabled: !r.enabled });
    await load();
  }

  async function remove(r: AlertRule) {
    if (!confirm(`Delete rule "${r.name}"?`)) return;
    await api.delete(`/api/alert-rules/${r._id}`);
    await load();
  }

  async function ack(t: AlertTrigger) {
    await api.post(`/api/alert-triggers/${t._id}/ack`);
    await load();
  }

  async function ackAll() {
    if (!confirm(`Acknowledge all ${triggers.length} triggers?`)) return;
    await api.post("/api/alert-triggers/ack-all");
    await load();
  }

  return (
    <div>
      {!embedded && (
        <>
          <h2>Alert Rules</h2>
          <p className="muted">
            Get notified the moment certain words appear in any tracked group — delays,
            cancellations, customs holds, etc.
          </p>
        </>
      )}

      {err && (
        <div style={{ color: "var(--danger)", marginBottom: 12 }}>Error: {err}</div>
      )}

      {!embedded && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>
              🚨 Unacknowledged triggers ({triggers.length})
            </h3>
            {triggers.length > 0 && (
              <button className="btn-secondary btn" onClick={ackAll} style={{ flex: 0 }}>
                Acknowledge all
              </button>
            )}
          </div>
          {triggers.length === 0 ? (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              No active triggers. New keyword matches will appear here.
            </p>
          ) : (
            <div style={{ marginTop: 12 }}>
              {triggers.map((t) => (
                <div
                  key={t._id}
                  style={{
                    padding: 10,
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderLeft: "3px solid var(--danger)",
                    borderRadius: 6,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
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
                    </div>
                    <button
                      className="btn-secondary btn"
                      onClick={() => ack(t)}
                      style={{ flex: 0, padding: "4px 10px", fontSize: 12 }}
                    >
                      Ack
                    </button>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {new Date(t.triggeredAt).toLocaleString()} · {t.groupName} · {t.sender}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    "{t.body.substring(0, 250)}{t.body.length > 250 ? "..." : ""}"
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "20px 0 12px" }}>
        <h3 style={{ margin: 0 }}>Rules</h3>
        <button className="btn" onClick={() => startNew()}>
          + New rule
        </button>
      </div>

      {!showForm && rules.length === 0 && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            No rules yet. Quick-start with a common SCM rule:
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SUGGESTED.map((s, i) => (
              <button
                key={i}
                className="btn-secondary btn"
                onClick={() => startNew(s)}
                style={{ fontSize: 13 }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{editing ? "Edit rule" : "New rule"}</h3>
          <label>Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div style={{ marginTop: 12 }}>
            <label>Keywords (comma-separated, case-insensitive)</label>
            <input
              value={form.keywordsText}
              onChange={(e) => setForm({ ...form, keywordsText: e.target.value })}
              placeholder="delayed, late, postponed"
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <label>Apply to (leave empty = all tracked groups)</label>
            <GroupPicker
              available={tracked}
              value={form.groups}
              onChange={(g) => setForm({ ...form, groups: g })}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button className="btn" onClick={save}>
              Save
            </button>
            <button className="btn-secondary btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!showForm && rules.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Keywords</th>
                <th>Scope</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r._id}>
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td>
                    {r.keywords.map((k, i) => (
                      <span key={i} className="tag">{k}</span>
                    ))}
                  </td>
                  <td className="muted">
                    {r.groupJids.length === 0
                      ? "All groups"
                      : `${r.groupJids.length} group(s)`}
                  </td>
                  <td>
                    <span
                      className={`status-badge status-${
                        r.enabled ? "ready" : "disconnected"
                      }`}
                    >
                      {r.enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn-secondary btn"
                      onClick={() => toggle(r)}
                      style={{ marginRight: 4 }}
                    >
                      {r.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn-secondary btn"
                      onClick={() => startEdit(r)}
                      style={{ marginRight: 4 }}
                    >
                      Edit
                    </button>
                    <button className="btn-danger btn" onClick={() => remove(r)}>
                      Del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
