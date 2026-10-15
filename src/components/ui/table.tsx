import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-outline-variant">
      <table
        className={cn("w-full border-collapse text-sm", className)}
        {...rest}
      />
    </div>
  );
}

export function TableHeader({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("bg-surface-container-high text-on-surface-variant", className)}
      {...rest}
    />
  );
}

export function TableBody({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-outline-variant", className)} {...rest} />;
}

export function TableFooter({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn("border-t border-outline-variant bg-surface-container-high", className)}
      {...rest}
    />
  );
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("transition-colors hover:bg-surface-container-high/60", className)} {...rest} />
  );
}

export function TableHead({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide",
        className,
      )}
      {...rest}
    />
  );
}

export function TableCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...rest} />;
}

export function TableCaption({
  className,
  ...rest
}: HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption className={cn("px-4 py-2 text-xs text-on-surface-variant", className)} {...rest} />
  );
}
