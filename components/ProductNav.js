/**
 * AJACE cross-app product switcher. A fixed, self-contained floating bar (no external
 * CSS, no layout impact) rendered in every app so the three deployments feel like one
 * product. Links come from NEXT_PUBLIC_* env with sensible defaults; the current app's
 * pill is highlighted and links to its own home.
 */
const APPS = [
  { key: "hr", label: "Immigration", url: process.env.NEXT_PUBLIC_HR_URL || "" },
  { key: "procurement", label: "Procurement", url: process.env.NEXT_PUBLIC_PROCUREMENT_URL || "https://pocu-wheat.vercel.app" },
  { key: "timesheet", label: "Timesheets", url: process.env.NEXT_PUBLIC_TIMESHEET_URL || "https://ajace-timesheets.vercel.app" },
];

const BRAND = "#4f46e5";

const bar = {
  position: "fixed",
  top: 10,
  right: 12,
  zIndex: 99999,
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "4px 6px",
  borderRadius: 999,
  background: "rgba(15,18,32,0.92)",
  boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  fontSize: 12,
  lineHeight: 1,
};

export function ProductNav({ current }) {
  return (
    <nav aria-label="AJACE apps" style={bar}>
      <span style={{ color: "#fff", fontWeight: 800, letterSpacing: "0.04em", padding: "0 6px", fontSize: 11 }}>
        AJACE
      </span>
      {APPS.map((a) => {
        const isCurrent = a.key === current;
        const href = isCurrent ? "/" : a.url;
        const disabled = !href;
        const style = {
          padding: "5px 10px",
          borderRadius: 999,
          textDecoration: "none",
          whiteSpace: "nowrap",
          color: isCurrent ? "#fff" : disabled ? "#6b7280" : "#cbd5e1",
          background: isCurrent ? BRAND : "transparent",
          fontWeight: isCurrent ? 700 : 500,
          pointerEvents: disabled ? "none" : "auto",
          cursor: disabled ? "default" : "pointer",
        };
        return disabled ? (
          <span key={a.key} style={style} title="Not deployed yet">
            {a.label}
          </span>
        ) : (
          <a key={a.key} href={href} style={style}>
            {a.label}
          </a>
        );
      })}
    </nav>
  );
}
