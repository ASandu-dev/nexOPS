"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "nexops-theme";
const COOKIE_KEY = "nexops-theme";

function setCookie(name: string, value: string) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;
  } catch {
    // Ignore cookie write failures
  }
}

function setStorage(name: string, value: string) {
  try {
    localStorage.setItem(name, value);
  } catch {
    // Storage can be unavailable (private mode)
  }
}

/**
 * Toggles the `dark` class on <html> and persists the choice. The initial value
 * is read from the DOM (set by bootstrap script) so the button never disagrees
 * with the rendered theme.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    const value = next ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next);
    setStorage(STORAGE_KEY, value);
    setCookie(COOKIE_KEY, value);
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
