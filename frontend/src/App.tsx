import { useEffect, useState } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Chat from "./pages/Chat";
import Browse from "./pages/Browse";
import Outbox from "./pages/Outbox";
import Schedules from "./pages/Schedules";
import Settings from "./pages/Settings";
import Agent from "./pages/Agent";

type Theme = "dark" | "light";

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WATracker</h1>
        <p className="muted" style={{ margin: "0 20px 20px", fontSize: 12 }}>
          For SCM buyers tracking deliveries
        </p>
        <nav>
          <NavLink to="/home" className={({ isActive }) => (isActive ? "active" : "")}>
            Home
          </NavLink>
          <NavLink to="/chat" className={({ isActive }) => (isActive ? "active" : "")}>
            Ask AI
          </NavLink>
          <NavLink to="/agent" className={({ isActive }) => (isActive ? "active" : "")}>
            Agent
          </NavLink>
          <NavLink to="/browse" className={({ isActive }) => (isActive ? "active" : "")}>
            Track
          </NavLink>
          <NavLink to="/outbox" className={({ isActive }) => (isActive ? "active" : "")}>
            Outbox
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
            Settings
          </NavLink>
        </nav>
      </aside>
      <div className="main-wrap">
        <div className="topbar">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span>{theme === "dark" ? "☀️" : "🌙"}</span>
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        </div>
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<Home />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/agent" element={<Agent />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/outbox" element={<Outbox />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/settings" element={<Settings />} />

            {/* Old routes redirect into the new structure */}
            <Route path="/dashboard" element={<Navigate to="/home" replace />} />
            <Route path="/orders" element={<Navigate to="/browse" replace />} />
            <Route path="/threads" element={<Navigate to="/browse" replace />} />
            <Route path="/senders" element={<Navigate to="/browse" replace />} />
            <Route path="/messages" element={<Navigate to="/browse" replace />} />
            <Route path="/followups" element={<Navigate to="/outbox" replace />} />
            <Route path="/drafts" element={<Navigate to="/outbox" replace />} />
            <Route path="/rules" element={<Navigate to="/settings" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function SchedulesPage() {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <h2 style={{ margin: "0 0 6px" }}>Recurring schedules</h2>
          <p className="muted" style={{ margin: 0 }}>
            Saved auto-chase schedules — these run on their own timetable and
            create messages that show up in your Outbox.
          </p>
        </div>
        <NavLink to="/outbox" className="btn-secondary btn">
          ← Back to Outbox
        </NavLink>
      </div>
      <Schedules />
    </div>
  );
}
