import { useAppTranslation } from "../localization";

/** Prime the live region before work begins; each invocation keeps its own atomic message. */
export function InvocationAnnouncements({
  messages,
}: {
  messages: readonly { id: number; text: string }[];
}) {
  const { t } = useAppTranslation("common");
  return (
    <div
      data-invocation-announcements
      role="status"
      aria-label={t("taskUpdates")}
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
      className="sr-only"
    >
      {messages.map(({ id, text }) => (
        <p key={id} data-announcement-invocation-id={id} aria-atomic="true">
          {text}
        </p>
      ))}
    </div>
  );
}
