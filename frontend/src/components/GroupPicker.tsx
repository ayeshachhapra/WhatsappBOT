import { useEffect, useMemo, useState } from "react";
import { api, GroupRef } from "../api";

interface Props {
  /** All available groups (from WhatsApp); if undefined the picker fetches them itself. */
  available?: GroupRef[];
  /** Current selection. */
  value: GroupRef[];
  /** Called with the new selection when the user clicks Save. */
  onChange: (selected: GroupRef[]) => void;
  /** Optional: show a Save button (true) vs commit-on-toggle (false). Default true. */
  withSaveButton?: boolean;
  /** Persist-immediately mode: when true, picker calls API itself to save tracked groups. */
  persistTracked?: boolean;
  /** Called with status messages (loading, errors) for parent display. */
  onStatus?: (msg: string | null) => void;
}

/**
 * Chip-based group picker:
 *  - Default state: shows selected groups as chips (with × to remove). "Edit" button opens picker.
 *  - Edit state: shows search box + checkbox list of all available groups. Save / Cancel.
 */
export default function GroupPicker({
  available,
  value,
  onChange,
  withSaveButton = true,
  persistTracked = false,
  onStatus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [allGroups, setAllGroups] = useState<GroupRef[]>(available || []);
  const [draft, setDraft] = useState<GroupRef[]>(value);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (available) setAllGroups(available);
  }, [available]);

  useEffect(() => {
    if (open && !available) {
      void fetchGroups();
    }
  }, [open]);

  async function fetchGroups() {
    setLoading(true);
    setErr(null);
    onStatus?.("Loading groups from WhatsApp...");
    try {
      const { groups } = await api.get<{ groups: GroupRef[] }>("/api/whatsapp/groups");
      setAllGroups(groups || []);
      onStatus?.(null);
    } catch (e: any) {
      setErr(e.message);
      onStatus?.(e.message);
    } finally {
      setLoading(false);
    }
  }

  const draftSet = useMemo(() => new Set(draft.map((g) => g.jid)), [draft]);

  function toggle(group: GroupRef) {
    if (draftSet.has(group.jid)) {
      setDraft(draft.filter((g) => g.jid !== group.jid));
    } else {
      setDraft([...draft, group]);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      if (persistTracked) {
        await api.put("/api/groups/tracked", { groups: draft });
      }
      onChange(draft);
      setOpen(false);
      setFilter("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(value);
    setOpen(false);
    setFilter("");
  }

  function removeChip(jid: string) {
    const next = value.filter((g) => g.jid !== jid);
    setDraft(next);
    if (persistTracked) {
      void api.put("/api/groups/tracked", { groups: next }).catch((e) => setErr(e.message));
    }
    onChange(next);
  }

  const visible = filter
    ? allGroups.filter((g) => g.name.toLowerCase().includes(filter.toLowerCase()))
    : allGroups;

  // ── Collapsed state: chips + edit button ──
  if (!open) {
    return (
      <div>
        <div className="chip-row">
          {value.length === 0 ? (
            <span className="muted">No groups selected.</span>
          ) : (
            value.map((g) => (
              <span className="chip" key={g.jid}>
                {g.name}
                <button
                  type="button"
                  className="chip-x"
                  onClick={() => removeChip(g.jid)}
                  aria-label={`Remove ${g.name}`}
                >
                  ×
                </button>
              </span>
            ))
          )}
          <button
            type="button"
            className="btn-secondary btn"
            onClick={() => {
              setDraft(value);
              setOpen(true);
            }}
            style={{ padding: "4px 12px", fontSize: 13 }}
          >
            {value.length === 0 ? "+ Pick groups" : "Edit"}
          </button>
        </div>
      </div>
    );
  }

  // ── Open state: search + checkbox list ──
  return (
    <div className="picker-open">
      <div className="row" style={{ marginBottom: 10, gap: 8 }}>
        <input
          autoFocus
          placeholder="Search groups..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {!available && (
          <button
            type="button"
            className="btn-secondary btn"
            onClick={fetchGroups}
            disabled={loading}
            style={{ flex: 0, padding: "8px 12px" }}
          >
            {loading ? "..." : "↻"}
          </button>
        )}
      </div>

      {err && <div style={{ color: "var(--danger)", marginBottom: 8, fontSize: 13 }}>{err}</div>}

      <div className="checkbox-list" style={{ maxHeight: 280 }}>
        {loading && allGroups.length === 0 && (
          <div className="checkbox-row muted">Loading...</div>
        )}
        {!loading && allGroups.length === 0 && (
          <div className="checkbox-row muted">
            No groups available. Make sure WhatsApp is connected.
          </div>
        )}
        {visible.map((g) => (
          <div className="checkbox-row" key={g.jid}>
            <input
              type="checkbox"
              id={"gp-" + g.jid}
              checked={draftSet.has(g.jid)}
              onChange={() => toggle(g)}
            />
            <label htmlFor={"gp-" + g.jid}>{g.name}</label>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {draft.length} selected
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn-secondary btn" onClick={cancel}>
            Cancel
          </button>
          {withSaveButton && (
            <button type="button" className="btn" onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
