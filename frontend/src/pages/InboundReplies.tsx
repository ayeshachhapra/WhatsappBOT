import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  EmailFollowUp,
  InboundReplyEnriched,
  ReplyMatchMethod,
} from "../api";

const MATCH_LABEL: Record<ReplyMatchMethod, string> = {
  plus_address: "plus-address",
  in_reply_to: "in-reply-to",
  subject_tag: "subject tag",
  from_address_heuristic: "sender heuristic",
  manual: "manual link",
  unmatched: "unmatched",
};

type Filter = "all" | "matched" | "unmatched";

export default function InboundReplies() {
  const [filter, setFilter] = useState<Filter>("all");
  const [replies, setReplies] = useState<InboundReplyEnriched[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const q =
        filter === "matched"
          ? "?matched=true"
          : filter === "unmatched"
          ? "?matched=false"
          : "";
      const { replies } = await api.get<{ replies: InboundReplyEnriched[] }>(
        `/api/inbound-replies${q}`
      );
      setReplies(replies);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filter]);

  return (
    <div>
      <h2 style={{ margin: "0 0 6px" }}>Inbound replies</h2>
      <p className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        Recent supplier replies received via Postmark inbound. Unmatched ones
        can be manually linked to a follow-up using its tracking tag.
      </p>

      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            style={{ flex: 0, minWidth: 160 }}
          >
            <option value="all">All replies</option>
            <option value="matched">Matched only</option>
            <option value="unmatched">Unmatched only</option>
          </select>
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

      {replies.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          {loading ? "Loading..." : "No replies."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {replies.map((r) => (
            <ReplyCard key={r._id} reply={r} onLinked={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyCard({
  reply,
  onLinked,
}: {
  reply: InboundReplyEnriched;
  onLinked: () => Promise<void>;
}) {
  const [linking, setLinking] = useState(false);

  async function linkManually() {
    const fuId = prompt(
      "Paste the follow-up _id (found in the PO detail page URL or in the database):"
    )?.trim();
    if (!fuId) return;
    setLinking(true);
    try {
      await api.post(`/api/email-follow-ups/${fuId}/link-reply`, {
        replyId: reply._id,
      });
      await onLinked();
    } catch (e: any) {
      alert("Link failed: " + e.message);
    } finally {
      setLinking(false);
    }
  }

  return (
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
          <div style={{ fontSize: 14 }}>
            <strong>{reply.subject || "(no subject)"}</strong>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            From {reply.fromName ? `${reply.fromName} ` : ""}
            &lt;{reply.fromEmail}&gt; ·{" "}
            {new Date(reply.receivedAt).toLocaleString()}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Match: <em>{MATCH_LABEL[reply.matchMethod] || reply.matchMethod}</em>
            {reply.followUp && (
              <>
                {" · linked to "}
                <Link to={`/po/${reply.followUp.purchaseOrderId}`}>
                  follow-up {reply.followUp.trackingTag}
                </Link>
              </>
            )}
          </div>
        </div>
        {!reply.isMatched && (
          <button
            className="btn-secondary btn"
            onClick={linkManually}
            disabled={linking}
            style={{ padding: "4px 10px", fontSize: 12 }}
          >
            {linking ? "..." : "Link manually"}
          </button>
        )}
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
        {reply.strippedReply || reply.textBody}
      </pre>
    </div>
  );
}
