"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, CopyX } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/cn";

export interface CodeBlockProps {
  code: string;
  label?: string;
  /** Hide the copy button (e.g. for read-only log tails). */
  copyable?: boolean;
  className?: string;
}

type CopyStatus = "idle" | "copied" | "failed";

const RESET_MS = 2000;

/**
 * Copy `text` to the clipboard, resolving `true` only when a path actually
 * reported success.
 *
 * `navigator.clipboard` is undefined outside secure contexts (plain `http://`
 * on a LAN address), so calling `writeText` directly would throw a TypeError
 * there; the legacy `execCommand` path keeps copy working for operators
 * browsing the app by IP, and permission denial falls back the same way.
 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or API failure — fall through to the legacy path.
    }
  }
  return legacyCopy(text);
}

/**
 * Pre-clipboard fallback: a temporary off-screen textarea is copied with
 * `document.execCommand("copy")`, which requires the element to be rendered
 * and selected — hence fixed positioning instead of `display: none`.
 */
function legacyCopy(text: string): boolean {
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const previousRange =
    selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  // iOS Safari ignores select() unless an explicit range is set.
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (selection !== null && previousRange !== null) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    previousFocus?.focus();
  }
  return copied;
}

/**
 * Monospace block with a copy-to-clipboard control. Content is rendered as a
 * text node, so it is escaped by React and safe for arbitrary command output.
 */
export function CodeBlock({ code, label, copyable = true, className }: CodeBlockProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function copy() {
    const succeeded = await copyText(code);
    setCopyStatus(succeeded ? "copied" : "failed");
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyStatus("idle"), RESET_MS);
  }

  const statusText =
    copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy";

  return (
    <div className={cn("overflow-hidden rounded-lg border border-outline-variant bg-surface-container-high", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-outline-variant px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          {label ?? "Command"}
        </span>
        {copyable ? (
          <Button
            variant="text"
            size="sm"
            onClick={copy}
            leadingIcon={
              copyStatus === "copied" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : copyStatus === "failed" ? (
                <CopyX className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )
            }
            aria-live="polite"
            aria-label={
              copyStatus === "copied"
                ? "Copied to clipboard"
                : copyStatus === "failed"
                  ? "Copy failed"
                  : "Copy to clipboard"
            }
          >
            {statusText}
          </Button>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto p-3 text-xs leading-relaxed text-on-surface">
        <code className="whitespace-pre-wrap break-all font-mono">{code}</code>
      </pre>
    </div>
  );
}
