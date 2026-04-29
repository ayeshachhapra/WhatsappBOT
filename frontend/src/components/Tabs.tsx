import { ReactNode, useState } from "react";

interface TabSpec {
  id: string;
  label: string;
  badge?: number;
  render: () => ReactNode;
}

interface Props {
  tabs: TabSpec[];
  defaultId?: string;
}

export default function Tabs({ tabs, defaultId }: Props) {
  const [active, setActive] = useState(defaultId || tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) || tabs[0];

  return (
    <div>
      <div className="tab-bar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${t.id === active ? "active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
            {t.badge !== undefined && t.badge > 0 && (
              <span className="tab-badge">{t.badge}</span>
            )}
          </button>
        ))}
      </div>
      <div className="tab-body">{current?.render()}</div>
    </div>
  );
}
