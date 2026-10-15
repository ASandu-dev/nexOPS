import type { Metadata } from "next";
import pkg from "../../../../package.json";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <SettingsClient controlPlaneVersion={pkg.version} />;
}
