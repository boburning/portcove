import type { CliCommandContext, PortDefinition, PortStatus, ReleaseChannel } from "./types";

export function primaryCliCommand(context: CliCommandContext, port: PortDefinition, status: PortStatus | undefined, channel: ReleaseChannel, sourcePath = "", biosPath = "") {
  const executable = context.executable ?? "<portcove-executable>";
  const missing: string[] = context.executable ? [] : ["Portcove CLI executable"];
  const args = ["--library", context.library_root];
  if (status?.active) args.push("exec", port.id, "--");
  else {
    args.push("--json", "--non-interactive", "ensure", port.id, "--channel", channel);
    for (const [required, flag, value, label] of [
      [port.source_profile, "--source", sourcePath, "source-path"],
      [port.bios_source_profile, "--bios", biosPath, "bios-path"],
    ] as const) {
      if (!required) continue;
      if (!value.trim()) missing.push(label);
      args.push(flag, value.trim() ? value : `<${label}>`);
    }
  }
  return { executable, args, missing, shell: shellCommand(executable, args, context.shell) };
}

export function shellCommand(executable: string, args: string[], shell: CliCommandContext["shell"]) {
  const tokens = [executable, ...args].map(value => quoteCliArg(value, shell));
  return (shell === "powershell" ? "& " : "") + tokens.join(" ");
}

export function quoteCliArg(value: string, shell: CliCommandContext["shell"]) {
  if (value.includes("\0")) throw new Error("Command arguments cannot contain a null character.");
  if (/^[a-zA-Z0-9._:/-]+$/.test(value)) return value;
  if (shell === "powershell") return "'" + value.replace(/['\u2018\u2019]/g, quote => quote + quote) + "'";
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
