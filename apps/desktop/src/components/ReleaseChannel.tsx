import { useEffect, useId, useRef, useState } from "react";
import type { PortStatus, ReleaseChannel } from "../types";
import { errorText, releaseChannelPresentation } from "../view-model";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSelectReturnFocus } from "./use-select-return-focus";

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
  const [open, setOpen] = useState(false);
  const [popupClosed, setPopupClosed] = useState(true);
  const labelId = useId();
  const triggerId = useId();
  const requestReturnFocus = useSelectReturnFocus(triggerId, pending || busy, popupClosed);
  const request = useRef(0);
  const savedChannel = releaseChannelPresentation(selected);
  const offeredKnown =
    channels.length > 0 && channels.every((value) => releaseChannelPresentation(value).known);
  const recognized = offeredKnown && channels.includes(selected);
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
    requestReturnFocus();
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
      }
    }
  };
  return (
    <section aria-label="Game release channel">
      {!recognized ? (
        <div role="status">
          <p>
            <strong>Selected channel: {savedChannel.label}</strong>
          </p>
          <p>
            {!savedChannel.known
              ? "This saved channel is not recognized in this version."
              : !offeredKnown
                ? "Release channel information is unavailable in this version."
                : "This saved channel is not offered by the current release channel information."}{" "}
            Your saved choice has not changed.
          </p>
        </div>
      ) : channels.length === 1 && channels[0] !== undefined ? (
        <p>
          <strong>{releaseChannelPresentation(channels[0]).label} only</strong>
        </p>
      ) : (
        <div className="grid gap-2">
          <span id={labelId} className="text-sm text-pc-muted-foreground">
            Release channel
          </span>
          <Select
            open={open}
            onOpenChange={(nextOpen, eventDetails) => {
              if (!nextOpen && eventDetails.reason === "escape-key") {
                eventDetails.event.stopPropagation();
                eventDetails.event.stopImmediatePropagation();
              }
              setOpen(nextOpen);
              setPopupClosed(false);
            }}
            onOpenChangeComplete={(nextOpen) => setPopupClosed(!nextOpen)}
            value={selected}
            disabled={busy || pending}
            onValueChange={(value) => {
              if (value) void choose(value);
            }}
          >
            <SelectTrigger
              id={triggerId}
              data-focusable
              aria-labelledby={labelId}
              className="w-full"
            >
              <SelectValue>{releaseChannelPresentation(selected).label}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {channels.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {releaseChannelPresentation(channel).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
