"use client";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/api/client";

export default function Topbar({ profile, active }) {
  const router = useRouter();
  const name = profile?.full_name || profile?.email || "User";
  const initials = name
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function logout() {
    const api = createClient();
    await api.auth.signOut();
    router.replace("/login");
  }

  return (
    <div className="topbar">
      <div className="container topbar-inner">
        <div className="row" style={{ gap: 22 }}>
          <div className="brand">
            <span className="logo">⏱</span>
            <span>
              Ajace Timesheets <span className="sub">· AI capture</span>
            </span>
          </div>
          <nav className="row" style={{ gap: 6 }}>
            <a
              href="/dashboard"
              className="tab"
              style={active === "dashboard" ? activeTab : tabStyle}
            >
              My Timesheet
            </a>
            {profile?.role === "admin" && (
              <a
                href="/admin"
                className="tab"
                style={active === "admin" ? activeTab : tabStyle}
              >
                Admin
              </a>
            )}
          </nav>
        </div>
        <div className="topbar-actions">
          <div className="userchip">
            <span className="avatar">{initials}</span>
            <span>
              {name}
              {profile?.role === "admin" && (
                <span className="badge purple" style={{ marginLeft: 6 }}>
                  admin
                </span>
              )}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

const tabStyle = { border: "none", borderBottom: "2px solid transparent" };
const activeTab = { border: "none", borderBottom: "2px solid var(--brand)", color: "var(--brand)" };
