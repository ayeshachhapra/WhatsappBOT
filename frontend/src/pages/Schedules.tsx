import { useEffect, useState } from "react";
import { api, GroupRef, ScheduleDoc } from "../api";
import GroupPicker from "../components/GroupPicker";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Form {
  name: string;
  mode: "static" | "ai_draft";
  messageText: string;
  aiPrompt: string;
  targetGroups: GroupRef[];
  times: string[];
  days: number[];
  enabled: boolean;
  autoSend: boolean;
}

const EMPTY_FORM: Form = {
  name: "",
  mode: "static",
  messageText: "",
  aiPrompt: "",
  targetGroups: [],
  times: ["09:00"],
  days: [],
  enabled: true,
  autoSend: false,
};

export default function Schedules() {
  const [schedules, setSchedules] = useState<ScheduleDoc[]>([]);
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [editing, setEditing] = useState<ScheduleDoc | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [{ schedules }, { groups }] = await Promise.all([
        api.get<{ schedules: ScheduleDoc[] }>("/api/schedules"),
        api.get<{ groups: GroupRef[] }>("/api/groups/tracked"),
      ]);
      setSchedules(schedules);
      setTracked(groups);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function startEdit(s: ScheduleDoc) {
    setEditing(s);
    setForm({
      name: s.name,
      mode: s.mode,
      messageText: s.messageText || "",
      aiPrompt: s.aiPrompt || "",
      targetGroups: s.targetGroups,
      times: s.schedule.times,
      days: s.schedule.days,
      enabled: s.enabled,
      autoSend: s.autoSend,
    });
    setShowForm(true);
  }

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      if (form.targetGroups.length === 0) throw new Error("Select at least one target group");
      const body = {
        name: form.name,
        mode: form.mode,
        messageText: form.mode === "static" ? form.messageText : null,
        aiPrompt: form.mode === "ai_draft" ? form.aiPrompt : null,
        targetGroups: form.targetGroups,
        schedule: { times: form.times, days: form.days },
        enabled: form.enabled,
        autoSend: form.autoSend,
      };
      if (editing) {
        await api.put(`/api/schedules/${editing._id}`, body);
      } else {
        await api.post("/api/schedules", body);
      }
      setShowForm(false);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(s: ScheduleDoc) {
    await api.patch(`/api/schedules/${s._id}/toggle`, { enabled: !s.enabled });
    await load();
  }

  async function trigger(s: ScheduleDoc) {
    if (!confirm(`Trigger "${s.name}" now?`)) return;
    try {
      await api.post(`/api/schedules/${s._id}/trigger`);
      alert("Triggered. Check Drafts (if not autoSend) or Send Log.");
      await load();
    } catch (e: any) {
      alert("Failed: " + e.message);
    }
  }

  async function remove(s: ScheduleDoc) {
    if (!confirm(`Delete "${s.name}"?`)) return;
    await api.delete(`/api/schedules/${s._id}`);
    await load();
  }

  function toggleDay(d: number) {
    setForm({
      ...form,
      days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d],
    });
  }

  function updateTime(idx: number, value: string) {
    const next = [...form.times];
    next[idx] = value;
    setForm({ ...form, times: next });
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Recurring messages — daily reminders, weekly summaries, or one-off blasts.
      </p>
      <div style={{ marginBottom: 16 }}>
        <button className="btn" onClick={startNew}>+ New Schedule</button>
      </div>

      {err && <div style={{ color: "var(--danger)", marginBottom: 12 }}>Error: {err}</div>}

      {showForm && (
        <div className="card">
          <h3>{editing ? "Edit Schedule" : "New Schedule"}</h3>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

          <div style={{ marginTop: 12 }}>
            <label>Mode</label>
            <div className="row">
              <label className="toggle">
                <input
                  type="radio"
                  checked={form.mode === "static"}
                  onChange={() => setForm({ ...form, mode: "static" })}
                />
                Static text
              </label>
              <label className="toggle">
                <input
                  type="radio"
                  checked={form.mode === "ai_draft"}
                  onChange={() => setForm({ ...form, mode: "ai_draft" })}
                />
                AI-drafted from recent messages
              </label>
            </div>
          </div>

          {form.mode === "static" ? (
            <div style={{ marginTop: 12 }}>
              <label>Message text</label>
              <textarea
                rows={4}
                value={form.messageText}
                onChange={(e) => setForm({ ...form, messageText: e.target.value })}
              />
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <label>AI prompt — what should the message do?</label>
              <textarea
                rows={4}
                value={form.aiPrompt}
                onChange={(e) => setForm({ ...form, aiPrompt: e.target.value })}
                placeholder="e.g., Nudge folks for any pending updates on the Q2 launch tracker."
              />
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label>Target groups</label>
            {tracked.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                No tracked groups. Set them on the Settings page first.
              </div>
            ) : (
              <GroupPicker
                available={tracked}
                value={form.targetGroups}
                onChange={(g) => setForm({ ...form, targetGroups: g })}
              />
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <label>Times (HH:mm, in {form.times.length === 1 ? "this" : "these"} timezone)</label>
            {form.times.map((t, i) => (
              <div className="row" key={i} style={{ marginBottom: 4 }}>
                <input value={t} onChange={(e) => updateTime(i, e.target.value)} />
                <button
                  className="btn-secondary btn"
                  style={{ flex: 0 }}
                  onClick={() => setForm({ ...form, times: form.times.filter((_, j) => j !== i) })}
                  disabled={form.times.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="btn-secondary btn"
              onClick={() => setForm({ ...form, times: [...form.times, "09:00"] })}
            >
              + Add time
            </button>
          </div>

          <div style={{ marginTop: 12 }}>
            <label>Days (empty = every day)</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {DAY_LABELS.map((d, i) => (
                <label key={i} className="toggle">
                  <input
                    type="checkbox"
                    checked={form.days.includes(i)}
                    onChange={() => toggleDay(i)}
                  />
                  {d}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }} className="row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.autoSend}
                onChange={(e) => setForm({ ...form, autoSend: e.target.checked })}
              />
              Auto-send (skip draft & approval)
            </label>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button className="btn" onClick={save} disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </button>
            <button className="btn-secondary btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mode</th>
              <th>Auto-send</th>
              <th>Schedule</th>
              <th>Groups</th>
              <th>Last sent</th>
              <th>Sent #</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s._id}>
                <td>
                  <strong>{s.name}</strong>
                  {!s.enabled && <span className="tag">disabled</span>}
                </td>
                <td>{s.mode === "ai_draft" ? "AI draft" : "Static"}</td>
                <td>{s.autoSend ? "Yes" : "No (drafts)"}</td>
                <td>
                  {s.schedule.times.join(", ")}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.schedule.days.length === 0
                      ? "Every day"
                      : s.schedule.days.map((d) => DAY_LABELS[d]).join(", ")}
                  </div>
                </td>
                <td>{s.targetGroups.length}</td>
                <td>{s.lastSentAt ? new Date(s.lastSentAt).toLocaleString() : "—"}</td>
                <td>{s.sendCount}</td>
                <td>
                  <button className="btn-secondary btn" onClick={() => trigger(s)} style={{ marginRight: 4 }}>
                    Run
                  </button>
                  <button className="btn-secondary btn" onClick={() => toggleEnabled(s)} style={{ marginRight: 4 }}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn-secondary btn" onClick={() => startEdit(s)} style={{ marginRight: 4 }}>
                    Edit
                  </button>
                  <button className="btn-danger btn" onClick={() => remove(s)}>
                    Del
                  </button>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  No schedules yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
