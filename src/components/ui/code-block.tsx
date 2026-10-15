"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/cn";

export interface CodeBlockProps {
  code: string;
  label?: string;
  /** Hide the copy button (e.g. for read-only log tails). */
  copyable?: boolean;
  className?: string;
}

/**
 * Monospace block with a copy-to-clipboard control. Content is rendered as a
 * text node, so it is escaped by React and safe for arbitrary command output.
 */
export function CodeBlock({ code, label, copyable = true, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the text remains selectable manually.
    }
  }

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
              copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )
            }
            aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto p-3 text-xs leading-relaxed text-on-surface">
        <code className="whitespace-pre-wrap break-all font-mono">{code}</code>
      </pre>
    </div>
  );
}
