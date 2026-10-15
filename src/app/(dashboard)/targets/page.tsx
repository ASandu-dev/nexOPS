import type { Metadata } from "next";
import { TargetsClient } from "./targets-client";

export const metadata: Metadata = { title: "Targets" };

export default function TargetsPage() {
  return <TargetsClient />;
}
