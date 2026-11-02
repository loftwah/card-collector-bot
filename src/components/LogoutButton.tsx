"use client";

import { useState } from "react";
import { api } from "@/lib/client";

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await api("/api/v1/auth/logout", { method: "POST", body: {} });
    } finally {
      window.location.href = "/";
    }
  }
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={logout} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
