import { useEffect, useState } from "react";
import Tabs from "../components/Tabs";
import Followups from "./Followups";
import Schedules from "./Schedules";
import { api } from "../api";

export default function Outbox() {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    api
      .get<{ drafts: any[] }>("/api/drafts?status=pending")
      .then(({ drafts }) => setPendingCount(drafts.length))
      .catch(() => {});
  }, []);

  return (
    <div>
      <h2 style={{ margin: "0 0 6px" }}>Outbox</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Everything outbound — drafts waiting for approval, sent messages, and recurring
        schedules.
      </p>
      <Tabs
        tabs={[
          {
            id: "followups",
            label: "Follow-ups",
            badge: pendingCount,
            render: () => <Followups />,
          },
          { id: "schedules", label: "Schedules", render: () => <Schedules /> },
        ]}
      />
    </div>
  );
}
