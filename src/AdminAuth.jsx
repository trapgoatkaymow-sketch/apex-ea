import { useEffect, useState } from "react";
import {
  completeMentorPasswordResetRemote,
  loginMentorAccount,
  registerMentorAccount,
  requestMentorPasswordResetRemote,
} from "./mentorsApi.js";

function AdminBusyLabel({ busy, children, busyText }) {
  return (
    <>
      {busy ? <span className="admin-btn-spinner" aria-hidden="true" /> : null}
      <span>{busy ? busyText || children : children}</span>
    </>
  );
}

function readResetTokenFromUrl() {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search || "");
    return String(params.get("reset") || params.get("resetToken") || "").trim();
  } catch {
    return "";
  }
}

function clearResetTokenFromUrl() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("reset") && !url.searchParams.has("resetToken")) {
      return;
    }
    url.searchParams.delete("reset");
    url.searchParams.delete("resetToken");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state || {}, "", next || "/admin");
  } catch {
    // ignore
  }
}

export default function AdminAuth({ onAuthenticated, showToast }) {
  const [mode, setMode] = useState(() =>
    readResetTokenFromUrl() ? "reset" : "signin"
  );
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [forgotEmail, setForgotEmail] = useState("");
  const [resetToken, setResetToken] = useState(() => readResetTokenFromUrl());
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");

  const [username, setUsername] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [contact, setContact] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    const token = readResetTokenFromUrl();
    if (!token) return;
    setResetToken(token);
    setMode("reset");
  }, []);

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

  function openForgot(event) {
    event.preventDefault();
    setForgotEmail(String(email || "").trim());
    setMode("forgot");
  }

  async function onForgotSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const target = String(forgotEmail || email || "").trim();
    if (!target.includes("@")) {
      showToast?.("Enter your mentor email");
      return;
    }
    setBusy(true);
    try {
      const result = await requestMentorPasswordResetRemote(target);
      showToast?.(
        result?.message ||
          "If that email belongs to an approved mentor, a reset link was sent."
      );
      setMode("signin");
      setEmail(target);
    } catch (error) {
      showToast?.(error.message || "Could not send reset email");
    } finally {
      setBusy(false);
    }
  }

  async function onResetSubmit(event) {
    event.preventDefault();
    if (busy) return;
    if (resetPassword !== resetConfirm) {
      showToast?.("Passwords do not match");
      return;
    }
    if (String(resetPassword || "").length < 6) {
      showToast?.("Password must be at least 6 characters");
      return;
    }
    setBusy(true);
    try {
      await completeMentorPasswordResetRemote({
        token: resetToken,
        password: resetPassword,
      });
      clearResetTokenFromUrl();
      setResetToken("");
      setResetPassword("");
      setResetConfirm("");
      setMode("signin");
      showToast?.("Password updated — sign in with your new password");
    } catch (error) {
      showToast?.(error.message || "Could not reset password");
    } finally {
      setBusy(false);
    }
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

  if (mode === "forgot") {
    return (
      <div className="admin-auth">
        <header className="admin-auth-brand">
          <img src="/logo.png" alt="" className="admin-auth-logo" width="64" height="64" />
          <p className="admin-auth-brand-name">APEX EA</p>
        </header>

        <section className="admin-auth-card">
          <h1 className="admin-auth-title">Forgot password</h1>
          <p className="admin-auth-sub">
            Approved mentors receive a reset link by email
          </p>

          <form className="admin-auth-form" onSubmit={onForgotSubmit}>
            <label className="admin-auth-label">
              Email
              <input
                className="admin-input"
                type="email"
                autoComplete="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                required
              />
            </label>

            <button
              className={`admin-btn admin-btn-solid admin-btn-block${busy ? " is-loading" : ""}`}
              type="submit"
              disabled={busy}
            >
              <AdminBusyLabel busy={busy} busyText="Sending…">
                Send reset link
              </AdminBusyLabel>
            </button>
          </form>

          <p className="admin-auth-switch">
            Remembered it{" "}
            <button type="button" className="admin-auth-link" onClick={() => setMode("signin")}>
              Sign in
            </button>
          </p>
        </section>
      </div>
    );
  }

  if (mode === "reset") {
    return (
      <div className="admin-auth">
        <header className="admin-auth-brand">
          <img src="/logo.png" alt="" className="admin-auth-logo" width="64" height="64" />
          <p className="admin-auth-brand-name">APEX EA</p>
        </header>

        <section className="admin-auth-card">
          <h1 className="admin-auth-title">Choose new password</h1>
          <p className="admin-auth-sub">
            Enter a new password for your approved mentor account
          </p>

          <form className="admin-auth-form" onSubmit={onResetSubmit}>
            <label className="admin-auth-label">
              New password
              <input
                className="admin-input"
                type="password"
                autoComplete="new-password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
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
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                required
                minLength={6}
              />
            </label>

            <button
              className={`admin-btn admin-btn-solid admin-btn-block${busy ? " is-loading" : ""}`}
              type="submit"
              disabled={busy || !resetToken}
            >
              <AdminBusyLabel busy={busy} busyText="Saving…">
                Update password
              </AdminBusyLabel>
            </button>
          </form>

          <p className="admin-auth-switch">
            Back to{" "}
            <button
              type="button"
              className="admin-auth-link"
              onClick={() => {
                clearResetTokenFromUrl();
                setMode("signin");
              }}
            >
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
              onClick={openForgot}
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
