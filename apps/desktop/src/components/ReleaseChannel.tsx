import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState } from "react";
import { useAppTranslation } from "../localization";
import type { PortStatus, ReleaseChannel } from "../types";
import { errorText, releaseChannelPresentation } from "../view-model";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSelectReturnFocus } from "./use-select-return-focus";

/** Channel names by static key, so extraction keeps every form. */
function channelName(t: TFunction<"gameUpdates">, channel: string) {
  switch (releaseChannelPresentation(channel).known ? channel : "unknown") {
    case "stable":
      return t("channel.stable");
    case "beta":
      return t("channel.beta");
    case "rolling":
      return t("channel.rolling");
    default:
      return t("channel.unknown");
  }
}

/**
 * Outcome identities, never English: the message is composed at render so it
 * follows a live language change. `failed` keeps Core's own summary.
 */
type ChannelMessage =
  | { kind: "unconfirmed" }
  | { kind: "checking" | "refreshed" | "refreshFailed"; channel: ReleaseChannel }
  | { kind: "failed"; summary: string };

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
  const [message, setMessage] = useState<ChannelMessage>();
  const { t } = useAppTranslation("gameUpdates");
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
        setMessage({ kind: "unconfirmed" });
        return;
      }
      setMessage({ kind: "checking", channel: status.channel });
      const checked = await refresh();
      if (current === request.current)
        setMessage({ kind: checked ? "refreshed" : "refreshFailed", channel: status.channel });
    } catch (error) {
      if (current === request.current) setMessage({ kind: "failed", summary: errorText(error) });
    } finally {
      if (current === request.current) {
        setPending(false);
      }
    }
  };
  const messageText = (value: ChannelMessage) => {
    switch (value.kind) {
      case "unconfirmed":
        return t("releaseChannel.unconfirmed");
      case "checking":
        return t("releaseChannel.checking", { channel: channelName(t, value.channel) });
      case "refreshed":
        return t("releaseChannel.refreshed", { channel: channelName(t, value.channel) });
      case "refreshFailed":
        return t("releaseChannel.refreshFailed", { channel: channelName(t, value.channel) });
      case "failed":
        return value.summary;
    }
  };
  return (
    <section aria-label={t("releaseChannel.label")}>
      {!recognized ? (
        <div role="status">
          <p>
            <strong>{t("releaseChannel.saved", { channel: channelName(t, selected) })}</strong>
          </p>
          <p>
            {!savedChannel.known
              ? t("releaseChannel.unrecognized")
              : !offeredKnown
                ? t("releaseChannel.unavailable")
                : t("releaseChannel.unlisted")}
          </p>
        </div>
      ) : channels.length === 1 && channels[0] !== undefined ? (
        <p>
          <strong>{t("releaseChannel.only", { channel: channelName(t, channels[0]) })}</strong>
        </p>
      ) : (
        <div className="grid gap-2">
          <span id={labelId} className="text-sm text-pc-muted-foreground">
            {t("releaseChannel.select")}
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
              <SelectValue>{channelName(t, selected)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {channels.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {channelName(t, channel)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {recognized && (
        <p>
          {channels.length === 1 ? t("releaseChannel.single") : t("releaseChannel.changeEffect")}
        </p>
      )}
      {recognized && (
        <p className="text-sm text-pc-muted-foreground">{t("releaseChannel.explanation")}</p>
      )}
      {pending && <p role="status">{t("releaseChannel.changing")}</p>}
      {message && <p role="status">{messageText(message)}</p>}
    </section>
  );
}
