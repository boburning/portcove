import { useEffect, useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { desktopApi } from "../api";
import { primaryCliCommand } from "../cli-command";
import { copyText } from "../clipboard";
import type { CliCommandContext, PortDefinition, PortStatus, ReleaseChannel } from "../types";
import { errorText } from "../view-model";
import { Icon } from "./ui";

export function CliContinuity({ generation, port, status, channel, sourcePath, biosPath }: {
  generation: number; port: PortDefinition; status?: PortStatus; channel: ReleaseChannel; sourcePath: string; biosPath: string;
}) {
  const [loaded, setLoaded] = useState<{ generation: number; context: CliCommandContext }>();
  const context = loaded?.generation === generation ? loaded.context : undefined;
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setLoaded(undefined); setError(undefined);
    desktopApi.cliCommandContext(generation).then(value => { if (current) setLoaded({ generation, context: value }); })
      .catch(value => { if (current) setError(errorText(value)); });
    return () => { current = false; };
  }, [generation, attempt]);
  const title = status?.active ? "Launch from another app" : "Set up from the command line";
  const copyLabel = status?.active ? "Copy launch command" : "Copy setup command";
  if (!context) return <section className="cli-continuity" aria-label={title}><strong>{title}</strong>
    {error ? <><p role="alert">{error}</p><button data-focusable onClick={() => setAttempt(value => value + 1)}>Retry command details</button></> : <p role="status">Finding the command-line app…</p>}
  </section>;
  let command;
  try { command = primaryCliCommand(context, port, status, channel, sourcePath, biosPath); }
  catch { return <section className="cli-continuity" aria-label={title}><strong>{title}</strong><p role="alert">Remove invalid characters from the selected paths before copying a command.</p></section>; }
  return <section className="cli-continuity" aria-label={title}>
    <div><strong>{title}</strong><span>Uses this library: <code>{context.library_root}</code></span></div>
    <p>{command.interpreter === "powershell" ? "PowerShell 7" : "sh / bash"}{command.missing.length ? " template" : " command"}</p>
    {command.missing.length > 0 && <p>Template — replace: {command.missing.join(", ")}.{!context.executable && " Install the standalone Portcove CLI or locate its executable first."}</p>}
    <CopyField key={command.shell} value={command.shell} label={command.missing.length ? "Copy command template" : copyLabel} />
    <p>{status?.active ? "The CLI checks this installation before launching it. This does not install or update the game." : "Running this command can download and install the selected release. Required original files are checked before use."}</p>
    <details><summary data-focusable>Separate program and arguments</summary>
      <p>For integrations that accept a program path and an argument array. The shell command above is for a terminal.</p>
      <CopyField key={command.executable} value={command.executable} label="Copy program path" />
      <CopyField key={JSON.stringify(command.args)} value={JSON.stringify(command.args)} label="Copy argument array" />
    </details>
  </section>;
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try { await copyText(value); setCopied(true); setFailed(false); }
    catch { setCopied(false); setFailed(true); }
  };
  return <><div className="command-line"><code>{value}</code><button data-focusable className="icon-button" aria-label={label} onClick={() => { void copy(); }}><Icon glyph={copied ? ClipboardCheck : Clipboard} /></button></div>
    {copied && <small role="status">Copied</small>}{failed && <small role="alert">Clipboard unavailable. Select and copy the text above.</small>}</>;
}
