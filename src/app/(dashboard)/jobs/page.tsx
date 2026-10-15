import type { Metadata } from "next";
import { JobsClient } from "./jobs-client";

export const metadata: Metadata = { title: "Jobs" };

export default function JobsPage() {
  return <JobsClient />;
}
