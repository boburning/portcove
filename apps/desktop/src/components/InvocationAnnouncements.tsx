/** Prime the live region before work begins; each invocation keeps its own atomic message. */
export function InvocationAnnouncements({
  messages,
}: {
  messages: readonly { id: number; text: string }[];
}) {
  return (
    <div
      data-invocation-announcements
      role="status"
      aria-label="Task updates"
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
