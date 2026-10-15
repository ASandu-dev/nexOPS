"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "nexops-theme";

/**
 * Toggles the `dark` class on <html> and persists the choice. The initial value
 * is read from the DOM (set by ThemeScript) so the button never disagrees with
 * the rendered theme.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // Storage can be unavailable (private mode); the in-memory toggle still works.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={dark}
      className="inline-flex size-9 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
    >
      {dark ? (
        <Sun className="size-5" aria-hidden="true" />
      ) : (
        <Moon className="size-5" aria-hidden="true" />
      )}
    </button>
  );
}
