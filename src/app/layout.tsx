import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { cookies } from "next/headers";
import { ThemeScript } from "@/components/shell/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "NexOPS",
    template: "%s · NexOPS",
  },
  description: "Self-hosted VM fleet management platform.",
  applicationName: "NexOPS",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

const THEME_COOKIE = "nexops-theme";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const theme = cookieStore.get(THEME_COOKIE)?.value;
  const isDark = theme === "dark";

  return (
    <ClerkProvider>
      <html lang="en" className={isDark ? "dark" : undefined} suppressHydrationWarning>
        <head>
          <ThemeScript />
        </head>
        <body className="min-h-dvh bg-surface text-on-surface antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
