import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds an interactive hover/active affordance when the card is clickable. */
  interactive?: boolean;
}

export function Card({ className, interactive = false, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-outline-variant bg-surface-container text-on-surface shadow-sm",
        interactive &&
          "cursor-pointer transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1 border-b border-outline-variant p-4", className)}
      {...rest}
    />
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: "h2" | "h3" | "h4";
}

export function CardTitle({ as: Tag = "h3", className, ...rest }: CardTitleProps) {
  return (
    <Tag
      className={cn("text-base font-semibold tracking-tight", className)}
      {...rest}
    />
  );
}

export function CardDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm text-on-surface-variant", className)} {...rest} />
  );
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-outline-variant p-4",
        className,
      )}
      {...rest}
    />
  );
}
