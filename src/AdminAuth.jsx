import { useState } from "react";
import {
  loginMentorAccount,
  registerMentorAccount,
} from "./mentorsApi.js";

function AdminBusyLabel({ busy, children, busyText }) {
  return (
    <>
      {busy ? <span className="admin-btn-spinner" aria-hidden="true" /> : null}
      <span>{busy ? busyText || children : children}</span>
    </>
  );
}

export default function AdminAuth({ onAuthenticated, showToast }) {
  const [mode, setMode] = useState("signin");
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [username, setUsername] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [contact, setContact] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function onSignIn(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const mentor = await loginMentorAccount({
        email: String(email || "").trim(),
        password: String(password || "").trim(),
      });
      onAuthenticated?.(mentor);
      showToast?.(`Welcome, ${mentor.username}`);
    } catch (error) {
      showToast?.(error.message || "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(event) {
    event.preventDefault();
    if (busy) return;
    if (regPassword !== confirmPassword) {
      showToast?.("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await registerMentorAccount({
        username,
        email: regEmail,
        contact,
        password: regPassword,
      });
      showToast?.("Account created — wait for super admin approval");
      setMode("signin");
      setEmail(regEmail);
      setPassword("");
      setUsername("");
      setRegEmail("");
      setContact("");
      setRegPassword("");
      setConfirmPassword("");
    } catch (error) {
      showToast?.(error.message || "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  function onForgotPassword(event) {
    event.preventDefault();
    showToast?.(
      "Ask the super admin to set a new password in Mentor Management (no email reset)"
    );
  }

  if (mode === "register") {
    return (
      <div className="admin-auth">
        <header className="admin-auth-brand">
          <img src="/logo.png" alt="" className="admin-auth-logo" width="64" height="64" />
          <p className="admin-auth-brand-name">APEX EA</p>
        </header>

        <section className="admin-auth-card">
          <h1 className="admin-auth-title">Register as mentor</h1>
          <p className="admin-auth-sub">
            Create your account to access the mentor
          </p>

          <form className="admin-auth-form" onSubmit={onRegister}>
            <label className="admin-auth-label">
              Username
              <input
                className="admin-input"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>

            <label className="admin-auth-label">
              Email
              <input
                className="admin-input"
                type="email"
                autoComplete="email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                required
              />
            </label>

            <label className="admin-auth-label">
              Contact number
              <input
                className="admin-input"
                type="tel"
                autoComplete="tel"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                required
              />
            </label>

            <label className="admin-auth-label">
              Password
              <input
                className="admin-input"
                type="password"
                autoComplete="new-password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>

            <label className="admin-auth-label">
              Confirm password
              <input
                className="admin-input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>

            <button
              className={`admin-btn admin-btn-solid admin-btn-block${busy ? " is-loading" : ""}`}
              type="submit"
              disabled={busy}
            >
              <AdminBusyLabel busy={busy} busyText="Creating…">
                Register
              </AdminBusyLabel>
            </button>
          </form>

          <p className="admin-auth-switch">
            Already have an account{" "}
            <button type="button" className="admin-auth-link" onClick={() => setMode("signin")}>
              Sign in
            </button>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-auth">
      <header className="admin-auth-brand">
        <img src="/logo.png" alt="" className="admin-auth-logo" width="64" height="64" />
        <p className="admin-auth-brand-name">APEX EA</p>
      </header>

      <section className="admin-auth-card">
        <h1 className="admin-auth-title">Sign in</h1>
        <p className="admin-auth-sub">
          Enter your credentials to access your mentor account
        </p>

        <form className="admin-auth-form" onSubmit={onSignIn}>
          <label className="admin-auth-label">
            Email
            <input
              className="admin-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          <div className="admin-auth-password-row">
            <label className="admin-auth-label admin-auth-label-grow">
              Password
              <input
                className="admin-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="button"
              className="admin-auth-forgot"
              onClick={onForgotPassword}
            >
              Forgot password
            </button>
          </div>

          <button
            className={`admin-btn admin-btn-solid admin-btn-block${busy ? " is-loading" : ""}`}
            type="submit"
            disabled={busy}
          >
            <AdminBusyLabel busy={busy} busyText="Signing in…">
              Sign in
            </AdminBusyLabel>
          </button>
        </form>

        <p className="admin-auth-switch">
          Don&apos;t have an account{" "}
          <button type="button" className="admin-auth-link" onClick={() => setMode("register")}>
            Register
          </button>
        </p>
      </section>
    </div>
  );
}
