import { Button } from "./ui/button";
import { DialogFooter } from "./ui/dialog";

export function ReviewedRemovalFooter({
  hasPreview,
  pending,
  dismiss,
  review,
  apply,
  keepLabel,
  reviewLabel,
  applyLabel,
  applyingLabel,
  canApply = true,
  cancelRef,
}: {
  hasPreview: boolean;
  pending?: "review" | "apply" | undefined;
  dismiss: () => void;
  review: () => Promise<void>;
  apply: () => Promise<void>;
  keepLabel: string;
  reviewLabel: string;
  applyLabel: string;
  applyingLabel: string;
  canApply?: boolean | undefined;
  cancelRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <DialogFooter className="mt-4">
      <Button
        ref={cancelRef}
        data-focusable
        variant="outline"
        disabled={pending === "apply"}
        onClick={dismiss}
      >
        {keepLabel}
      </Button>
      {!hasPreview && (
        <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
          {reviewLabel}
        </Button>
      )}
      {hasPreview && (
        <Button
          data-focusable
          variant="destructive"
          disabled={Boolean(pending) || !canApply}
          onClick={() => void apply()}
        >
          {pending === "apply" ? applyingLabel : applyLabel}
        </Button>
      )}
    </DialogFooter>
  );
}
