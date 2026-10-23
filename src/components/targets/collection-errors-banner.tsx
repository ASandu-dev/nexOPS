import { AlertTriangle } from "lucide-react";

export interface CollectionErrorsBannerProps {
  /** `<collector>: <error>` strings exactly as reported by the agent. */
  errors: readonly string[];
}

/**
 * Restrained banner for metric collectors that failed on the last check-in.
 *
 * The error strings are server-derived and rendered verbatim as text nodes.
 */
export function CollectionErrorsBanner({ errors }: CollectionErrorsBannerProps) {
  if (errors.length === 0) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-warning-container bg-warning-container p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-on-warning-container">
        <AlertTriangle className="size-4" aria-hidden="true" />
        Incomplete metric collection
      </p>
      <p className="text-sm text-on-warning-container">
        {errors.length === 1
          ? "One collector failed on the last check-in; the metrics it reports are unavailable."
          : `${errors.length} collectors failed on the last check-in; the metrics they report are unavailable.`}
      </p>
      <ul className="flex flex-col gap-1">
        {errors.map((error, index) => (
          <li
            key={`${error}-${index}`}
            className="font-mono text-xs text-on-warning-container"
          >
            {error}
          </li>
        ))}
      </ul>
    </div>
  );
}
