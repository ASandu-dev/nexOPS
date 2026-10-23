"use client";

import { HardDrive, Network, PackageCheck, RefreshCw } from "lucide-react";
import type { TargetDetailDto, TelemetryDto } from "@/lib/types";
import { formatAbsoluteTime } from "@/lib/display";
import { formatBytes } from "@/lib/format";
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
  type BadgeVariant,
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

/**
 * Kernel operstate is normalised to `up`, `down` or `unknown` by the agent. The
 * badge always carries the state as text so it never depends on colour alone.
 */
function operstatePresentation(state: string): { variant: BadgeVariant; label: string } {
  const normalized = state.trim().toLowerCase();
  if (normalized === "up") return { variant: "online", label: "up" };
  if (normalized === "down") return { variant: "error", label: "down" };
  if (normalized === "" || normalized === "unknown") return { variant: "neutral", label: "unknown" };
  return { variant: "neutral", label: normalized };
}

/** Live rate in bytes per second; the first sample has no baseline, hence the em dash. */
function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "—" : `${formatBytes(bytesPerSecond)}/s`;
}

export function SystemTab({ target, latest }: SystemTabProps) {
  const swapUsed = latest?.swapUsedBytes ?? null;
  const swapTotal = latest?.swapTotalBytes ?? null;
  const swapLabel =
    swapUsed !== null && swapTotal !== null && swapTotal > 0
      ? `${formatBytes(swapUsed)} / ${formatBytes(swapTotal)}`
      : "—";

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
                {latest?.osPrettyName ? (
                  <span className="flex flex-col">
                    <span>{latest.osPrettyName}</span>
                    <span className="text-xs text-on-surface-variant">
                      {target.os}
                      {target.osVersion ? ` ${target.osVersion}` : ""}
                    </span>
                  </span>
                ) : (
                  <span>
                    {target.os}
                    {target.osVersion ? ` ${target.osVersion}` : ""}
                  </span>
                )}
              </Field>
              <Field label="CPU">{latest?.cpuModel ?? "—"}</Field>
              <Field label="CPU cores">{latest?.cores ?? "—"}</Field>
              <Field label="Kernel">{latest?.kernel ?? "—"}</Field>
              <Field label="Architecture">{target.arch ?? "—"}</Field>
              <Field label="Boot time">
                {latest?.bootTime ? formatAbsoluteTime(latest.bootTime) : "—"}
              </Field>
              <Field label="Swap">{swapLabel}</Field>
              <Field label="Agent version">
                {latest?.agentVersion ?? target.agent?.agentVersion ?? "—"}
              </Field>
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
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="size-4" aria-hidden="true" />
            Disk I/O
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {latest === null || latest.diskIO.length === 0 ? (
            <p className="p-4 text-sm text-on-surface-variant">No disk I/O data reported.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Read rate</TableHead>
                  <TableHead>Write rate</TableHead>
                  <TableHead className="hidden sm:table-cell">Read total</TableHead>
                  <TableHead className="hidden sm:table-cell">Write total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {latest.diskIO.map((device) => (
                  <TableRow key={device.device}>
                    <TableCell className="font-medium">{device.device}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatRate(device.readRateBps)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatRate(device.writeRateBps)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
                      {formatBytes(device.readBytes)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
                      {formatBytes(device.writeBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="size-4" aria-hidden="true" />
            Network interfaces
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {latest === null || latest.net.length === 0 ? (
            <p className="p-4 text-sm text-on-surface-variant">
              No network interface data reported.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Interface</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Addresses</TableHead>
                  <TableHead>RX</TableHead>
                  <TableHead>TX</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {latest.net.map((iface) => {
                  const operstate = operstatePresentation(iface.operstate);
                  return (
                    <TableRow key={iface.name}>
                      <TableCell className="font-medium">{iface.name}</TableCell>
                      <TableCell>
                        <Badge variant={operstate.variant} withDot>
                          {operstate.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {iface.ips.length === 0 ? (
                          <span className="text-on-surface-variant">—</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1">
                            {iface.ips.map((ip) => (
                              <li
                                key={ip}
                                className="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-xs text-on-surface"
                              >
                                {ip}
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatRate(iface.rxRateBps)}
                        <span className="hidden text-xs font-normal text-on-surface-variant sm:block">
                          {formatBytes(iface.rxBytes)} total
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatRate(iface.txRateBps)}
                        <span className="hidden text-xs font-normal text-on-surface-variant sm:block">
                          {formatBytes(iface.txBytes)} total
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
