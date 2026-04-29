import { useEffect, useState } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Chat from "./pages/Chat";
import Browse from "./pages/Browse";
import Outbox from "./pages/Outbox";
import Settings from "./pages/Settings";

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
          <NavLink to="/browse" className={({ isActive }) => (isActive ? "active" : "")}>
            Browse
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
            <Route path="/browse" element={<Browse />} />
            <Route path="/outbox" element={<Outbox />} />
            <Route path="/settings" element={<Settings />} />
            {/* Old routes redirect into the new structure */}
            <Route path="/dashboard" element={<Navigate to="/home" replace />} />
            <Route path="/orders" element={<Navigate to="/browse" replace />} />
            <Route path="/threads" element={<Navigate to="/browse" replace />} />
            <Route path="/senders" element={<Navigate to="/browse" replace />} />
            <Route path="/messages" element={<Navigate to="/browse" replace />} />
            <Route path="/followups" element={<Navigate to="/outbox" replace />} />
            <Route path="/drafts" element={<Navigate to="/outbox" replace />} />
            <Route path="/schedules" element={<Navigate to="/outbox" replace />} />
            <Route path="/rules" element={<Navigate to="/settings" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
