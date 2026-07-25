"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/api/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <div className="center-wrap">
      <div className="card" style={{ width: 400 }}>
        <div className="card-pad">
          <div className="brand" style={{ marginBottom: 4 }}>
            <span className="logo">⏱</span>
            <span>Ajace Timesheets</span>
          </div>
          <h2 style={{ fontSize: 22, marginTop: 14 }}>Welcome back</h2>
          <p className="muted" style={{ marginTop: 4, marginBottom: 18 }}>
            Sign in to upload and review your timesheet.
          </p>

          {err && (
            <div className="alert error" style={{ marginBottom: 14 }}>
              {err}
            </div>
          )}

          <form onSubmit={onSubmit}>
            <div className="field">
              <label>Work email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@ajace.com"
                autoComplete="email"
              />
            </div>
            <div className="field">
              <div className="between">
                <label>Password</label>
                <a href="/forgot" style={{ fontSize: 12 }}>Forgot password?</a>
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy} style={{ marginTop: 6 }}>
              {busy ? <span className="spinner" /> : "Sign in"}
            </button>
          </form>

          <p className="muted" style={{ textAlign: "center", marginTop: 18, fontSize: 13 }}>
            New here? <a href="/signup">Create an account</a>
          </p>
        </div>
      </div>
    </div>
  );
}
