import type { TFunction } from "i18next";
import { useAppTranslation } from "../localization";

export function catalogFailureFallback(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("details" in value) ||
    !("message" in value) ||
    typeof value.message !== "string"
  )
    return undefined;
  const details = value.details;
  if (
    typeof details !== "object" ||
    details === null ||
    !("catalog_fallback_code" in details) ||
    typeof details.catalog_fallback_code !== "string"
  )
    return undefined;
  return { code: details.catalog_fallback_code, reason: value.message };
}

export function CatalogFallbackReason({
  reason,
  code,
  position,
  count,
}: {
  reason: string;
  code?: string | null | undefined;
  position: number;
  count: number;
}) {
  const { t } = useAppTranslation("catalogUpdates");
  return (
    <div className="catalog-fallback-reason">
      <p>{catalogFallbackSummary(t, code)}</p>
      <details>
        <summary
          data-focusable
          aria-label={t("custom.fallbackDetailsLabel", { position, total: count })}
        >
          {t("custom.technicalDetails")}
        </summary>
        <code className="[overflow-wrap:anywhere]">{reason}</code>
      </details>
    </div>
  );
}

function catalogFallbackSummary(t: TFunction<"catalogUpdates">, code: string | null | undefined) {
  switch (code) {
    case "selected_definition_unavailable":
      return t("custom.fallbackNotLoaded");
    case "listing_directory_unavailable":
      return t("listings.savedDirectoryUnavailable");
    case "replay_floor":
      return t("custom.fallbackReplay");
    case "untrusted_key":
      return t("custom.fallbackUntrusted");
    case "signature_invalid":
      return t("custom.fallbackSignature");
    case "invalid_validity":
      return t("custom.fallbackExpired");
    default:
      return t("custom.fallbackGeneric");
  }
}
