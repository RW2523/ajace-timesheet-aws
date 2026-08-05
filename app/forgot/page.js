"use client";
import { useState } from "react";
import { createClient } from "@/lib/api/client";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);
  const [mailOn, setMailOn] = useState(true);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const api = createClient();
    const { data, error } = await api.auth.resetPasswordForEmail(email);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMailOn(data?.emailConfigured !== false);
    setSent(true);
  }

  return (
    <div className="center-wrap">
      <div className="card" style={{ width: 400 }}>
        <div className="card-pad">
          <div className="brand" style={{ marginBottom: 4 }}>
            <span className="logo">⏱</span><span>Ajace Timesheets</span>
          </div>
          <h2 style={{ fontSize: 22, marginTop: 14 }}>Reset your password</h2>
          <p className="muted" style={{ marginTop: 4, marginBottom: 18 }}>
            Enter your work email and we’ll send you a reset link.
          </p>

          {err && <div className="alert error" style={{ marginBottom: 14 }}>{err}</div>}

          {sent ? (
            mailOn ? (
              <div className="alert ok">
                If an account exists for <b>{email}</b>, a password-reset link is on its way.
                Check your inbox (and spam).
              </div>
            ) : (
              // Don't tell people to check an inbox when no sender is configured.
              // "warn", deliberately distinct from the green branch above it:
              // this is the "no link is coming, go find a human" dead end.
              <div className="alert warn">
                Reset email isn’t set up on this deployment yet, so no link was sent.
                Ask your administrator to reset your password.
              </div>
            )
          ) : (
            <form onSubmit={onSubmit}>
              <div className="field">
                <label>Work email</label>
                <input type="email" required value={email}
                  onChange={(e) => setEmail(e.target.value)} placeholder="you@ajace.com" autoComplete="email" />
              </div>
              <button className="btn btn-primary btn-block" disabled={busy} style={{ marginTop: 6 }}>
                {busy ? <span className="spinner" /> : "Send reset link"}
              </button>
            </form>
          )}

          <p className="muted" style={{ textAlign: "center", marginTop: 18, fontSize: 13 }}>
            <a href="/login">← Back to sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}
