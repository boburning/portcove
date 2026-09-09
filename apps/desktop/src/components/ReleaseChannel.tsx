import { useEffect, useRef, useState } from "react";
import type { PortStatus, ReleaseChannel } from "../types";
import { errorText } from "../view-model";
import { ChoiceMenu } from "./ChoiceMenu";

const labels: Record<ReleaseChannel, string> = { stable: "Stable", beta: "Beta", rolling: "Rolling" };

export function ReleaseChannelControl({ channels, selected, busy, change, refresh }: {
  channels: ReleaseChannel[]; selected: ReleaseChannel; busy: boolean;
  change: (channel: ReleaseChannel) => Promise<PortStatus | undefined>;
  refresh: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const root = useRef<HTMLElement>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const choose = async (channel: ReleaseChannel) => {
    if (channel === selected || pending || busy) return;
    const current = ++request.current;
    setPending(true); setMessage(undefined);
    try {
      const status = await change(channel);
      if (current !== request.current) return;
      if (!status) { setMessage("Channel change was not confirmed. Check the current selection before retrying."); return; }
      setMessage(`${labels[status.channel]} selected. Checking releases…`);
      const checked = await refresh();
      if (current === request.current) setMessage(checked ? `${labels[status.channel]} selected. Release information refreshed.` : `${labels[status.channel]} saved. Release information could not be refreshed; check for updates again.`);
    } catch (error) { if (current === request.current) setMessage(errorText(error)); }
    finally {
      if (current === request.current) {
        setPending(false);
        window.requestAnimationFrame(() => { if (current === request.current) root.current?.querySelector<HTMLButtonElement>(".choice-trigger")?.focus(); });
      }
    }
  };
  return <section ref={root} aria-label="Game release channel">
    {channels.length === 1 ? <p><strong>{labels[channels[0]]} only</strong></p> : <ChoiceMenu label="Release channel" value={selected} options={channels.map(value => ({ value, label: labels[value] }))} disabled={busy || pending} onChange={value => { void choose(value); }} />}
    <p>{channels.length === 1 ? "This game offers one release channel." : "Changing channel selects releases for future checks and updates. Your installed version stays unchanged."}</p>
    {pending && <p role="status">Changing release channel…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
