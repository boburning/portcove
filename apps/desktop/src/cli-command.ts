import type { PortDefinition, PortStatus, ReleaseChannel } from "./types";

export function primaryCliCommand(port: PortDefinition, status: PortStatus | undefined, channel: ReleaseChannel, sourcePath = "", biosPath = "") {
  if (status?.active) return `portcove exec ${quoteCliArg(port.id)} --`;

  const arguments_ = [
    "portcove", "--json", "--non-interactive", "ensure", quoteCliArg(port.id), "--channel", channel,
  ];
  if (port.source_profile) arguments_.push("--source", quoteCliArg(sourcePath.trim() || "<source-path>"));
  if (port.bios_source_profile) arguments_.push("--bios", quoteCliArg(biosPath.trim() || "<bios-path>"));
  return arguments_.join(" ");
}

export function quoteCliArg(value: string) {
  if (/^[a-zA-Z0-9._:/-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
