import { countMessage } from "./localization";
import { errorText, failurePresentation } from "./view-model";

/**
 * SteamGridDB messages are written for players; generic presentation summaries
 * would hide which provider step failed. Rate limits keep their retry time.
 */
export function steamGridDbErrorText(error: unknown, includeRetryDelay = true) {
  // A device-level cause (such as no secure credential store) has its own
  // player summary; the provider message would only repeat technical detail.
  const presentation = failurePresentation(error);
  if (presentation?.presentation_key.startsWith("credential_store_")) return presentation.summary;
  if (typeof error === "object" && error && "message" in error) {
    const value = error as { message: unknown; details?: Record<string, string> };
    const seconds = Number(value.details?.retry_after_seconds);
    const message = String(value.message);
    return includeRetryDelay && Number.isSafeInteger(seconds) && seconds > 0
      ? `${message}. ${countMessage(seconds, "retryAfterSeconds")}`
      : message;
  }
  return errorText(error);
}
