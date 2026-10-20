"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { SnackbarProvider } from "@/components/ui/snackbar";
import { ThemeToggle } from "./theme-toggle";
import { SidebarBrand, SidebarNav } from "./sidebar-nav";

const TITLES: ReadonlyArray<readonly [prefix: string, title: string]> = [
  ["/overview", "Overview"],
  ["/targets", "Targets"],
  ["/jobs", "Jobs"],
  ["/audit", "Activity"],
  ["/settings", "Settings"],
];

function titleForPath(pathname: string): string {
  const match = TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match ? match[1] : "NexOPS";
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll and close on Escape while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  return (
    <SnackbarProvider>
      <div className="min-h-dvh md:grid md:grid-cols-[16rem_1fr]">
        <aside className="hidden border-r border-outline-variant bg-surface-container md:flex md:flex-col md:gap-4 md:p-3">
          <SidebarBrand />
          <SidebarNav />
        </aside>

        {drawerOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col gap-4 border-r border-outline-variant bg-surface-container p-3 shadow-xl"
            >
              <div className="flex items-center justify-between">
                <SidebarBrand />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="inline-flex size-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <X className="size-5" aria-hidden="true" />
                </button>
              </div>
              <SidebarNav onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        ) : null}

        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-outline-variant bg-surface/95 px-4 backdrop-blur md:px-6">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              className="inline-flex size-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary md:hidden"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            <h1 className="flex-1 truncate text-base font-semibold text-on-surface">
              {titleForPath(pathname)}
            </h1>
            <ThemeToggle />
            <UserButton
              appearance={{ elements: { avatarBox: "size-8" } }}
              showName={false}
            />
          </header>

          <main className="flex-1 px-4 py-5 md:px-6 md:py-6">{children}</main>
        </div>
      </div>
    </SnackbarProvider>
  );
}
