import { useAppTranslation } from "../../localization";

type Retry = { retry_after: number } | null | undefined;

/** Whether Core's temporary-retry schedule still waits at `now` (milliseconds). */
export function waitingRetry(retry: Retry, now = Date.now()): retry is { retry_after: number } {
  return Boolean(retry && retry.retry_after * 1000 > now);
}

/**
 * Core's next automatic attempt, a Unix-second instant, as a labelled local
 * time with its zone, so the player can tell when setup runs again.
 */
export function NextAttemptTime({ at }: { at: number }) {
  const { i18n } = useAppTranslation("gameFiles");
  const instant = new Date(at * 1000);
  const text = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
  return <time dateTime={instant.toISOString()}>{text}</time>;
}
