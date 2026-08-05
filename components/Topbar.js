"use client";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/api/client";
// The same predicate app/admin/page.js guards with. A nav link that leads to a
// redirect, or a missing link to a page you are allowed to open, are the two
// halves of the same bug — so both ask this one function.
import { canFileForOthers } from "@/lib/aws/roles";

export default function Topbar({ profile, active }) {
  const privileged = canFileForOthers(profile);
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
            {privileged && (
              <a
                href="/admin"
                className="tab"
                style={active === "admin" ? activeTab : tabStyle}
              >
                {profile?.role === "admin" ? "Admin" : "Payroll"}
              </a>
            )}
          </nav>
        </div>
        <div className="topbar-actions">
          <div className="userchip">
            <span className="avatar">{initials}</span>
            <span>
              {name}
              {/* Spell the role the person actually HAS. The old test printed
                  the badge only for admin, so an HR user — who can file hours in
                  other people's names — wore no badge at all and looked like an
                  ordinary employee to anyone reading over their shoulder. */}
              {profile?.role === "admin" && (
                <span className="badge purple" style={{ marginLeft: 6 }}>
                  admin
                </span>
              )}
              {profile?.role === "hr" && (
                <span className="badge amber" style={{ marginLeft: 6 }}>
                  HR
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
