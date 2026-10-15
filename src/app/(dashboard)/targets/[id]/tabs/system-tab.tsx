"use client";

import { PackageCheck, RefreshCw } from "lucide-react";
import type { TargetDetailDto, TelemetryDto } from "@/lib/types";
import { formatAbsoluteTime } from "@/lib/display";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

export interface SystemTabProps {
  target: TargetDetailDto;
  latest: TelemetryDto | null;
}

function serviceVariant(state: string): "online" | "error" | "neutral" {
  const normalized = state.toLowerCase();
  if (normalized === "active" || normalized === "running") return "online";
  if (normalized === "failed") return "error";
  return "neutral";
}

export function SystemTab({ target, latest }: SystemTabProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System information</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Hostname">{latest?.hostname ?? target.hostname ?? "—"}</Field>
              <Field label="Operating system">
                {target.os}
                {target.osVersion ? ` ${target.osVersion}` : ""}
              </Field>
              <Field label="Kernel">{latest?.kernel ?? "—"}</Field>
              <Field label="Architecture">{target.arch ?? "—"}</Field>
              <Field label="Boot time">
                {latest?.bootTime ? formatAbsoluteTime(latest.bootTime) : "—"}
              </Field>
              <Field label="Agent version">{latest?.agentVersion ?? target.agent?.agentVersion ?? "—"}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="size-4" aria-hidden="true" />
              Package updates
            </CardTitle>
          </CardHeader>
          <CardContent>
            {latest?.pkgUpdates ? (
              <div className="flex flex-col gap-3">
                <p className="text-3xl font-semibold tabular-nums text-on-surface">
                  {latest.pkgUpdates.availableCount}
                </p>
                <p className="text-sm text-on-surface-variant">updates available</p>
                {latest.pkgUpdates.rebootRequired ? (
                  <Badge variant="degraded" withDot>
                    Reboot required
                  </Badge>
                ) : (
                  <Badge variant="online" withDot>
                    No reboot required
                  </Badge>
                )}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-on-surface-variant">
                <RefreshCw className="size-4" aria-hidden="true" />
                Unknown — run a “Check updates” job to populate this.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {latest === null || latest.services.length === 0 ? (
            <p className="p-4 text-sm text-on-surface-variant">No service data reported.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {latest.services.map((service) => (
                  <TableRow key={service.name}>
                    <TableCell className="font-medium">{service.name}</TableCell>
                    <TableCell>
                      <Badge variant={serviceVariant(service.state)} withDot>
                        {service.state}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">{label}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}
