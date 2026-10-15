import type { Metadata } from "next";
import { TargetDetailClient } from "./target-detail-client";

export const metadata: Metadata = { title: "Target" };

export default async function TargetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TargetDetailClient id={id} />;
}
