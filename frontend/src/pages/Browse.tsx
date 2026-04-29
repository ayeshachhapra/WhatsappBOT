import Tabs from "../components/Tabs";
import Orders from "./Orders";
import Threads from "./Threads";
import Senders from "./Senders";
import Messages from "./Messages";

export default function Browse() {
  return (
    <div>
      <h2 style={{ margin: "0 0 6px" }}>Browse</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Drill into your captured data — orders by reference, conversations by topic,
        people, or the raw message log.
      </p>
      <Tabs
        tabs={[
          { id: "orders", label: "Orders", render: () => <Orders /> },
          { id: "threads", label: "Threads", render: () => <Threads /> },
          { id: "senders", label: "Senders", render: () => <Senders /> },
          { id: "messages", label: "Messages", render: () => <Messages /> },
        ]}
      />
    </div>
  );
}
