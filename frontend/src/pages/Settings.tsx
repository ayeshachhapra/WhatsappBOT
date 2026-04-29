import { useEffect, useState } from "react";
import { api, GroupRef } from "../api";
import GroupPicker from "../components/GroupPicker";
import Rules from "./Rules";

interface Status {
  status: string;
  message?: string;
  qr?: string | null;
  messageCount?: number;
  droppedCount?: number;
  errorCount?: number;
}

export default function Settings() {
  const [status, setStatus] = useState<Status>({ status: "disconnected" });
  const [tracked, setTracked] = useState<GroupRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [pickerStatus, setPickerStatus] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      const data = await api.get<Status>("/api/whatsapp/status");
      setStatus(data);
    } catch {
      // ignore
    }
  }

  async function loadTracked() {
    try {
      const { groups } = await api.get<{ groups: GroupRef[] }>("/api/groups/tracked");
      setTracked(groups || []);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshStatus();
    loadTracked();
    const id = setInterval(refreshStatus, 2000);
    return () => clearInterval(id);
  }, []);

  async function connect() {
    setBusy(true);
    try {
      await api.post("/api/whatsapp/connect");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.post("/api/whatsapp/disconnect");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (
      !confirm(
        "Logout will erase WhatsApp credentials. You'll need to scan QR again. Continue?"
      )
    )
      return;
    setBusy(true);
    try {
      await api.post("/api/whatsapp/logout");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  const isReady = status.status === "ready";

  return (
    <div>
      <h2 style={{ margin: "0 0 6px" }}>Settings</h2>
      <p className="muted" style={{ marginBottom: 20 }}>
        Pair your WhatsApp account, choose tracked groups, and configure keyword alerts.
      </p>

      <div className="card">
        <div className="row">
          <div>
            <h3 style={{ margin: 0 }}>WhatsApp link</h3>
            <div style={{ marginTop: 6 }}>
              <span className={`status-badge status-${status.status}`}>{status.status}</span>
              {status.message && (
                <span className="muted" style={{ marginLeft: 12 }}>
                  {status.message}
                </span>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {!isReady && status.status !== "connecting" && status.status !== "qr_ready" && (
              <button className="btn" disabled={busy} onClick={connect}>
                Connect
              </button>
            )}
            {(isReady || status.status === "qr_ready" || status.status === "connecting") && (
              <button
                className="btn-secondary btn"
                disabled={busy}
                onClick={disconnect}
                style={{ marginRight: 8 }}
              >
                Disconnect
              </button>
            )}
            <button className="btn-danger btn" disabled={busy} onClick={logout}>
              Logout
            </button>
          </div>
        </div>

        {status.qr && status.status === "qr_ready" && (
          <div className="qr-box" style={{ marginTop: 16 }}>
            <h3 style={{ margin: 0, marginBottom: 12 }}>Scan with WhatsApp</h3>
            <img src={status.qr} alt="WhatsApp QR" />
            <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
              Open WhatsApp → Settings → Linked Devices → Link a Device
            </p>
          </div>
        )}

        {isReady && (
          <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Messages received: <strong>{status.messageCount ?? 0}</strong> ·
            Dropped: <strong>{status.droppedCount ?? 0}</strong> ·
            Errors: <strong>{status.errorCount ?? 0}</strong>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Tracked Groups</h3>
        <p className="muted" style={{ marginTop: 4 }}>
          Only messages from these groups are captured and analysed. Pick the groups
          your suppliers, freight forwarders, and warehouses use.
        </p>
        {!isReady && (
          <div
            style={{
              background: "rgba(210,153,34,0.12)",
              border: "1px solid var(--warn)",
              padding: 10,
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
            }}
          >
            WhatsApp not connected — connect above to load your group list.
          </div>
        )}
        <GroupPicker
          value={tracked}
          onChange={setTracked}
          persistTracked
          onStatus={setPickerStatus}
        />
        {pickerStatus && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {pickerStatus}
          </div>
        )}
      </div>

      <div className="section-header">
        <h3>Alert Rules</h3>
      </div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Get notified the moment certain words appear in any tracked group — delays,
        cancellations, customs holds, etc.
      </p>
      <Rules embedded />
    </div>
  );
}
