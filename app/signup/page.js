"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/api/client";

export default function SignupPage() {
  const router = useRouter();
  const [f, setF] = useState({
    email: "", password: "", full_name: "", phone: "",
    employer: "Ajace", client: "", job_title: "", employee_code: "",
    manager_name: "", manager_email: "",
  });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function onSubmit(e) {
    e.preventDefault();
    setErr(""); setMsg(""); setBusy(true);
    const api = createClient();
    const { data, error } = await api.auth.signUp({
      email: f.email,
      password: f.password,
      options: {
        data: {
          app: "ajace_timesheets", // marker → server auto-confirms timesheet signups
          full_name: f.full_name, phone: f.phone, employer: f.employer,
          client: f.client, job_title: f.job_title, employee_code: f.employee_code,
          manager_name: f.manager_name, manager_email: f.manager_email, country: "US",
        },
      },
    });
    if (error) { setErr(error.message); setBusy(false); return; }
    // timesheet signups are auto-confirmed server-side; if signUp didn't return a
    // session, sign in directly so the user lands on their dashboard.
    if (!data.session) {
      const { error: e2 } = await api.auth.signInWithPassword({
        email: f.email, password: f.password,
      });
      if (e2) {
        setMsg("Account created. Please sign in to continue.");
        setBusy(false);
        return;
      }
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <div className="center-wrap">
      <div className="card" style={{ width: 560 }}>
        <div className="card-pad">
          <div className="brand" style={{ marginBottom: 4 }}>
            <span className="logo">⏱</span>
            <span>Ajace Timesheets</span>
          </div>
          <h2 style={{ fontSize: 22, marginTop: 14 }}>Create your account</h2>
          <p className="muted" style={{ marginTop: 4, marginBottom: 18 }}>
            Tell us a few details so your timesheets are filed correctly.
          </p>

          {err && <div className="alert error" style={{ marginBottom: 14 }}>{err}</div>}
          {msg && <div className="alert ok" style={{ marginBottom: 14 }}>{msg}</div>}

          <form onSubmit={onSubmit}>
            <SectionLabel>Account</SectionLabel>
            <div className="grid-2">
              <Field label="Work email" req><input type="email" required value={f.email} onChange={set("email")} placeholder="you@ajace.com" /></Field>
              <Field label="Password" req hint="Min 10 characters"><input type="password" required minLength={10} value={f.password} onChange={set("password")} placeholder="••••••••" /></Field>
            </div>

            <SectionLabel>Personal details</SectionLabel>
            <div className="grid-2">
              <Field label="Full name" req><input required value={f.full_name} onChange={set("full_name")} placeholder="Jane Doe" /></Field>
              <Field label="Phone"><input value={f.phone} onChange={set("phone")} placeholder="(555) 123-4567" /></Field>
            </div>

            <SectionLabel>Employment</SectionLabel>
            <div className="grid-2">
              <Field label="Employer" req><input required value={f.employer} onChange={set("employer")} placeholder="Ajace" /></Field>
              <Field label="Client / placement"><input value={f.client} onChange={set("client")} placeholder="e.g. HCPSS" /></Field>
              <Field label="Job title"><input value={f.job_title} onChange={set("job_title")} placeholder="Software Engineer" /></Field>
              <Field label="Employee code"><input value={f.employee_code} onChange={set("employee_code")} placeholder="EMP-1024" /></Field>
            </div>

            <SectionLabel>Reporting manager</SectionLabel>
            <div className="grid-2">
              <Field label="Manager name"><input value={f.manager_name} onChange={set("manager_name")} placeholder="John Smith" /></Field>
              <Field label="Manager email"><input type="email" value={f.manager_email} onChange={set("manager_email")} placeholder="manager@ajace.com" /></Field>
            </div>

            <button className="btn btn-primary btn-block" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? <span className="spinner" /> : "Create account"}
            </button>
          </form>

          <p className="muted" style={{ textAlign: "center", marginTop: 16, fontSize: 13 }}>
            Already have an account? <a href="/login">Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, req, hint, children }) {
  return (
    <div className="field">
      {/* the shared `.req` marker (globals.css), not a local red asterisk */}
      <label>{label}{req && <span className="req" title="Required" aria-hidden="true">*</span>}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--faint)", margin: "10px 0 8px" }}>
      {children}
    </div>
  );
}
