import { cn } from "cn";
import { controlFocus } from "./control-style";

/** Presentation only; capture, redaction and clipboard state stay with the caller. */
export function ReadOnlyTextField({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <textarea
      readOnly
      aria-label={label}
      value={value}
      className={cn(
        "max-h-96 min-h-20 w-full min-w-0 resize-y overflow-auto rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-pc-foreground",
        controlFocus,
        className,
      )}
    />
  );
}
