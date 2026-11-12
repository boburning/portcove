import { useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { CancellationState } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";

export function OperationCancellation({
  operationId,
  state,
  label,
}: {
  operationId: string;
  state?: CancellationState | undefined;
  /** A translated, operation-specific label; defaults to a generic one. */
  label?: string;
}) {
  const { t } = useAppTranslation("operations");
  const [requested, setRequested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = async () => {
    setPending(true);
    setError(undefined);
    try {
      const result = await desktopApi.cancelOperation(operationId);
      setRequested(result.requested);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(false);
    }
  };
  if (state?.phase === "finishing") return <p role="status">{t("cancellation.finishing")}</p>;
  return (
    <div className="operation-cancellation my-3">
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={pending || requested || state?.requested}
        onClick={() => {
          void request();
        }}
      >
        {requested || state?.requested
          ? t("cancellation.requested")
          : pending
            ? t("cancellation.requesting")
            : (label ?? t("cancellation.cancel"))}
      </Button>
      {(requested || state?.requested) && <p role="status">{t("cancellation.requestedBody")}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
