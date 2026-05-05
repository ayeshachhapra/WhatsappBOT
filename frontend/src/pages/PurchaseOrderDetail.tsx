import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  EmailFollowUp,
  EmailFollowUpCreateResponse,
  PurchaseOrder,
} from "../api";

interface DetailResponse {
  purchaseOrder: PurchaseOrder;
}

const STATUS_BADGE: Record<EmailFollowUp["status"], { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--muted)" },
  sent: { label: "Sent", color: "var(--warn)" },
  replied: { label: "Replied", color: "var(--accent)" },
  closed: { label: "Closed", color: "var(--muted)" },
};

const MATCH_LABEL: Record<string, string> = {
  plus_address: "plus-address",
  in_reply_to: "in-reply-to header",
  subject_tag: "subject tag",
  from_address_heuristic: "sender heuristic",
  manual: "manual link",
  unmatched: "unmatched",
};

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [followUps, setFollowUps] = useState<EmailFollowUp[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(false);
  const [supplierEmail, setSupplierEmail] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [savingSupplier, setSavingSupplier] = useState(false);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const [poRes, fuRes] = await Promise.all([
        api.get<DetailResponse>(`/api/purchase-orders/${id}`),
        api.get<{ followUps: EmailFollowUp[] }>(
          `/api/email-follow-ups?purchaseOrderId=${id}`
        ),
      ]);
      setPo(poRes.purchaseOrder);
      setFollowUps(fuRes.followUps);
      setSupplierEmail(poRes.purchaseOrder.supplierEmail || "");
      setSupplierName(poRes.purchaseOrder.supplierName || "");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function saveSupplier() {
    if (!po) return;
    setSavingSupplier(true);
    try {
      await api.patch(`/api/purchase-orders/${po._id}`, {
        supplierEmail: supplierEmail.trim() || null,
        supplierName: supplierName.trim() || null,
      });
      setEditingSupplier(false);
      await load();
    } catch (e: any) {
      alert("Save failed: " + e.message);
    } finally {
      setSavingSupplier(false);
    }
  }

  if (!po && loading) {
    return <div className="muted" style={{ padding: 20 }}>Loading...</div>;
  }
  if (!po) {
    return (
      <div style={{ padding: 20 }}>
        <p>Purchase order not found.</p>
        <Link to="/browse">← Back to Track</Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/browse" className="muted" style={{ fontSize: 13 }}>
          ← Back to Track
        </Link>
      </div>
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <h2 style={{ margin: "0 0 4px", fontFamily: "monospace" }}>
              {po.poNumber}
            </h2>
            <div className="muted" style={{ fontSize: 14 }}>
              {po.productName} — {po.companyName}
            </div>
            {po.eta && (
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                ETA: {new Date(po.eta).toLocaleDateString()}
              </div>
            )}
          </div>
          <button
            className="btn"
            onClick={() => setShowModal(true)}
            disabled={!po.supplierEmail}
            title={
              po.supplierEmail
                ? "Open Gmail with a pre-filled follow-up"
                : "Set a supplier email below first"
            }
          >
            ✉️ Send Follow-Up
          </button>
        </div>
      </div>

      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>Supplier contact</h3>
          {!editingSupplier && (
            <button
              className="btn-secondary btn"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() => setEditingSupplier(true)}
            >
              Edit
            </button>
          )}
        </div>
        {editingSupplier ? (
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ fontSize: 13 }}>
              Email
              <input
                type="email"
                value={supplierEmail}
                onChange={(e) => setSupplierEmail(e.target.value)}
                placeholder="supplier@example.com"
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Name (optional)
              <input
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Contact name"
              />
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={saveSupplier} disabled={savingSupplier}>
                {savingSupplier ? "Saving..." : "Save"}
              </button>
              <button
                className="btn-secondary btn"
                onClick={() => {
                  setEditingSupplier(false);
                  setSupplierEmail(po.supplierEmail || "");
                  setSupplierName(po.supplierName || "");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : po.supplierEmail ? (
          <div style={{ fontSize: 14 }}>
            {po.supplierName ? <strong>{po.supplierName}</strong> : null}
            {po.supplierName ? " · " : ""}
            <span>{po.supplierEmail}</span>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            No supplier email on file. Add one to enable email follow-ups.
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>Email follow-ups</h3>
        {followUps.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No follow-ups sent yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {followUps.map((fu) => (
              <FollowUpCard key={fu._id} fu={fu} />
            ))}
          </div>
        )}
      </div>

      {showModal && po.supplierEmail && (
        <FollowUpModal
          po={po}
          onClose={() => setShowModal(false)}
          onSent={async () => {
            setShowModal(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function FollowUpCard({ fu }: { fu: EmailFollowUp }) {
  const badge = STATUS_BADGE[fu.status];
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 13 }}>
          <strong>{fu.subject}</strong>
        </div>
        <span
          className="status-badge"
          style={{ background: `${badge.color}22`, color: badge.color }}
        >
          {badge.label}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        To: {fu.toEmail}
        {fu.ccEmails.length > 0 ? ` · Cc: ${fu.ccEmails.join(", ")}` : ""}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {fu.sentAt
          ? `Sent ${new Date(fu.sentAt).toLocaleString()}`
          : `Drafted ${new Date(fu.createdAt).toLocaleString()}`}
        {" · tag "}
        <code>{fu.trackingTag}</code>
      </div>
      <pre
        style={{
          fontSize: 12,
          marginTop: 8,
          padding: 8,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          whiteSpace: "pre-wrap",
          maxHeight: 200,
          overflow: "auto",
        }}
      >
        {fu.body}
      </pre>
      {fu.replies.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Replies ({fu.replies.length})
          </div>
          {fu.replies.map((r) => (
            <div
              key={r._id}
              style={{
                borderLeft: "3px solid var(--accent)",
                paddingLeft: 10,
                marginTop: 8,
              }}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                {r.fromName ? `${r.fromName} ` : ""}
                &lt;{r.fromEmail}&gt; · {new Date(r.receivedAt).toLocaleString()}
                {" · matched via "}
                <em>{MATCH_LABEL[r.matchMethod] || r.matchMethod}</em>
              </div>
              <pre
                style={{
                  fontSize: 12,
                  marginTop: 4,
                  whiteSpace: "pre-wrap",
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {r.strippedReply || r.textBody}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function defaultTemplate(po: PurchaseOrder): { subject: string; body: string } {
  const subject = `Status update on ${po.poNumber} — ${po.productName}`;
  const body =
    `Hi,\n\nCould you please share the latest status on ${po.poNumber} ` +
    `(${po.productName})? ${po.eta ? `ETA on file is ${new Date(po.eta).toLocaleDateString()}.` : ""}\n\n` +
    `Thanks,\nMoviant team`;
  return { subject, body };
}

function FollowUpModal({
  po,
  onClose,
  onSent,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const tpl = defaultTemplate(po);
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body);
  const [submitting, setSubmitting] = useState(false);

  async function send() {
    if (!subject.trim() || !body.trim()) {
      alert("Subject and body are required");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await api.post<EmailFollowUpCreateResponse>(
        "/api/email-follow-ups",
        {
          purchaseOrderId: po._id,
          toEmail: po.supplierEmail,
          toName: po.supplierName || null,
          subject,
          body,
        }
      );
      const opened = window.open(resp.gmailComposeUrl, "_blank");
      if (!opened) {
        // popup-blocked — fall back to mailto in the current tab
        window.location.href = resp.mailtoUrl;
      }
      // Optimistic mark-sent. Don't block the UX on it.
      api
        .post(`/api/email-follow-ups/${resp.id}/mark-sent`)
        .catch(() => {
          /* swallow — user can retry; status will stay "draft" */
        });
      await onSent();
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          margin: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>Compose follow-up</h3>
          <button className="btn-secondary btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          To: {po.supplierEmail}
          {po.supplierName ? ` (${po.supplierName})` : ""}. A tracking tag will
          be appended to the subject and the configured inbound address will be
          Cc'd so replies are captured.
        </div>
        <label style={{ fontSize: 13 }}>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label style={{ fontSize: 13, marginTop: 8, display: "block" }}>
          Body
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            style={{ width: "100%", fontFamily: "inherit" }}
          />
        </label>
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <button className="btn" onClick={send} disabled={submitting}>
            {submitting ? "Opening..." : "Open in Gmail & mark sent"}
          </button>
          <button className="btn-secondary btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
