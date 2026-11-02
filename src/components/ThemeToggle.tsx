"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    const media = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(current === "dark" || (current === "system" && media) ? "dark" : "light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.cookie = `fb_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    try {
      localStorage.setItem("foilbury-theme", next);
    } catch {
      // Preferences remain optional.
    }
  }

  return (
    <button type="button" className="btn btn-ghost h-10 w-10 p-0" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title="Theme">
      {theme === "dark" ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}
