import type { Metadata } from "next";
import { OverviewClient } from "./overview-client";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return <OverviewClient />;
}
