import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ManagementRow } from "../../components/ui/patterns";
import type { ExactReleaseReview, PortStatus } from "../../types";
import { formatBytes } from "../../view-model";

export interface ExactReleaseActions {
  available: () => Promise<boolean>;
  review: (version: string) => Promise<ExactReleaseReview>;
  pin: (review: ExactReleaseReview) => Promise<PortStatus | undefined>;
  follow: () => Promise<PortStatus | undefined>;
}

export function ExactReleasePreference({
  status,
  actions,
  busy,
}: {
  status: PortStatus;
  actions: ExactReleaseActions;
  busy: boolean;
}) {
  const { t } = useTranslation("gameUpdates");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const [available, setAvailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [version, setVersion] = useState("");
  const [review, setReview] = useState<ExactReleaseReview>();
  const [error, setError] = useState<"review" | "pin" | "follow">();
  const [pending, setPending] = useState<"review" | "pin" | "follow">();
  const pinned = status.exact_release;
  const latest = status.last_update_check?.check.channel_latest_version;
  const availability = actions.available;

  useEffect(() => {
    let current = true;
    void availability().then(
      (allowed) => {
        if (current) setAvailable(allowed === true);
      },
      () => {
        if (current) setAvailable(false);
      },
    );
    return () => {
      current = false;
    };
  }, [availability]);

  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );

  useEffect(() => {
    if (expanded) input.current?.focus();
  }, [expanded]);

  async function reviewVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || pending || busy) return;
    const current = ++request.current;
    setPending("review");
    setReview(undefined);
    setError(undefined);
    try {
      const result = await actions.review(version);
      if (current === request.current) setReview(result);
    } catch {
      if (current === request.current) setError("review");
    } finally {
      if (current === request.current) setPending(undefined);
    }
  }

  function cancelReview() {
    request.current++;
    setReview(undefined);
    setError(undefined);
    setPending(undefined);
    setExpanded(false);
    chooser.current?.focus();
  }

  async function savePreference(
    mode: "pin" | "follow",
    apply: () => Promise<PortStatus | undefined>,
  ) {
    if (pending || busy) return;
    const current = ++request.current;
    setPending(mode);
    setError(undefined);
    setReview(undefined);
    try {
      const result = await apply();
      if (current !== request.current) return;
      if (!result) {
        setError(mode);
        return;
      }
      setExpanded(false);
      setVersion("");
    } catch {
      if (current === request.current) setError(mode);
    } finally {
      if (current === request.current) setPending(undefined);
    }
  }

  if (!available && !pinned) return null;

  return (
    <ManagementRow
      title={t("releasePreference.title")}
      description={
        <div role="status">
          <p>
            {pinned
              ? t("releasePreference.pinned", { version: pinned.version })
              : t("releasePreference.following")}
          </p>
          {pinned && latest && (
            <p>{t("releasePreference.channelCandidate", { version: latest })}</p>
          )}
        </div>
      }
    >
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap justify-end gap-2">
          {available && (
            <Button
              ref={chooser}
              type="button"
              variant="outline"
              disabled={busy || pending === "pin" || pending === "follow"}
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => (expanded ? cancelReview() : setExpanded(true))}
            >
              {t("releasePreference.choose")}
            </Button>
          )}
          {pinned && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || Boolean(pending)}
              onClick={() => void savePreference("follow", actions.follow)}
            >
              {t("releasePreference.follow")}
            </Button>
          )}
        </div>
        {available && (
          <div id={id} hidden={!expanded}>
            <form
              aria-labelledby={id + "-label"}
              className="grid min-w-0 gap-2"
              onSubmit={(event) => void reviewVersion(event)}
            >
              <label htmlFor={id + "-tag"} id={id + "-label"}>
                {t("releasePreference.tag")}
              </label>
              <Input
                ref={input}
                id={id + "-tag"}
                name="tag"
                required
                maxLength={255}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy || Boolean(pending)}
                value={version}
                onChange={(event) => {
                  setVersion(event.currentTarget.value);
                  setReview(undefined);
                  setError(undefined);
                }}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="submit" variant="outline" disabled={busy || Boolean(pending)}>
                  {pending === "review"
                    ? t("releasePreference.reviewing")
                    : t("releasePreference.review")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending === "pin" || pending === "follow"}
                  onClick={cancelReview}
                >
                  {t("releasePreference.cancel")}
                </Button>
              </div>
            </form>
            <div className="mt-3 grid min-w-0 gap-2 text-sm wrap-anywhere">
              <p role="status">
                {review &&
                  t("releasePreference.package", {
                    version: review.selection.version,
                    filename: review.selection.filename,
                    size: formatBytes(review.selection.size),
                  })}
              </p>
              {review && (
                <>
                  <p>{t("releasePreference.saveCompatibility")}</p>
                  <Button
                    type="button"
                    className="justify-self-end"
                    disabled={busy || Boolean(pending)}
                    onClick={() => void savePreference("pin", () => actions.pin(review))}
                  >
                    {t("releasePreference.pin")}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        {error !== undefined && (
          <p role="status" className="max-w-72 text-sm wrap-anywhere">
            {error === "review"
              ? t("releasePreference.reviewFailed")
              : error === "pin"
                ? t("releasePreference.pinFailed")
                : t("releasePreference.followFailed")}
          </p>
        )}
      </div>
    </ManagementRow>
  );
}
