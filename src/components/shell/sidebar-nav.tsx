"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  ScrollText,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "next";
import { cn } from "@/lib/cn";

interface NavItem {
  href: Route;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/targets", label: "Targets", icon: Server },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/audit", label: "Activity", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface SidebarNavProps {
  /** Called after a nav link is activated (used to close the mobile drawer). */
  onNavigate?: () => void;
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary",
              active
                ? "bg-primary-container text-on-primary-container"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface",
            )}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <Link
      href="/overview"
      className="flex items-center gap-2 rounded-md px-3 py-2 focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-on-primary">
        N
      </span>
      <span className="text-lg font-semibold tracking-tight text-on-surface">NexOPS</span>
    </Link>
  );
}
