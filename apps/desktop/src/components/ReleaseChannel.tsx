import { useEffect, useRef, useState } from "react";
import type { PortStatus, ReleaseChannel } from "../types";
import { errorText, releaseChannelPresentation } from "../view-model";
import { ChoiceMenu } from "./ChoiceMenu";

export function ReleaseChannelControl({
  channels,
  selected,
  busy,
  change,
  refresh,
}: {
  channels: ReleaseChannel[];
  selected: ReleaseChannel;
  busy: boolean;
  change: (channel: ReleaseChannel) => Promise<PortStatus | undefined>;
  refresh: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const root = useRef<HTMLElement>(null);
  const request = useRef(0);
  const recognized =
    channels.length > 0 &&
    channels.includes(selected) &&
    channels.every((value) => releaseChannelPresentation(value).known);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const choose = async (channel: ReleaseChannel) => {
    if (!recognized || !channels.includes(channel) || channel === selected || pending || busy)
      return;
    const current = ++request.current;
    setPending(true);
    setMessage(undefined);
    try {
      const status = await change(channel);
      if (current !== request.current) return;
      if (!status) {
        setMessage(
          "Channel change was not confirmed. Check the current selection before retrying.",
        );
        return;
      }
      setMessage(
        `${releaseChannelPresentation(status.channel).label} selected. Checking releases…`,
      );
      const checked = await refresh();
      if (current === request.current)
        setMessage(
          checked
            ? `${releaseChannelPresentation(status.channel).label} selected. Release information refreshed.`
            : `${releaseChannelPresentation(status.channel).label} saved. Release information could not be refreshed; check for updates again.`,
        );
    } catch (error) {
      if (current === request.current) setMessage(errorText(error));
    } finally {
      if (current === request.current) {
        setPending(false);
        window.requestAnimationFrame(() => {
          if (current === request.current)
            root.current?.querySelector<HTMLButtonElement>(".choice-trigger")?.focus();
        });
      }
    }
  };
  return (
    <section ref={root} aria-label="Game release channel">
      {!recognized ? (
        <p role="status">Release channel information is unavailable in this version.</p>
      ) : channels.length === 1 ? (
        <p>
          <strong>{releaseChannelPresentation(channels[0]).label} only</strong>
        </p>
      ) : (
        <ChoiceMenu
          label="Release channel"
          value={selected}
          options={channels.map((value) => ({
            value,
            label: releaseChannelPresentation(value).label,
          }))}
          disabled={busy || pending}
          onChange={(value) => {
            void choose(value);
          }}
        />
      )}
      {recognized && (
        <p>
          {channels.length === 1
            ? "This game offers one release channel."
            : "Changing channel selects releases for future checks and updates. Your installed version stays unchanged."}
        </p>
      )}
      {pending && <p role="status">Changing release channel…</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
