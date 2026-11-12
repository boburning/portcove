import type { TFunction } from "i18next";
import { useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { pickSourcePath } from "../file-picker";
import { errorText } from "../view-model";
import type { PortStatus, SourceProfile, SourceRecord, SourceReuseReview } from "../types";
import { useSetupReviewSelection } from "../features/game-file-discovery/setup-review-selection";
import type { Perform } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { Button } from "./ui/button";

// Ephemeral readback only. Core owns identity, compatibility, baseline and repair.

type ReuseCode = "registration_changed" | "profile_missing" | "location_changed";

/** App-owned reuse failures are codes translated at render; Core text stays verbatim. */
class ReuseError extends Error {
  readonly code: ReuseCode;
  /** `message` carries readable text for shared failure notices that only read errorText. */
  constructor(code: ReuseCode, message: string) {
    super(message);
    this.code = code;
  }
}

type ReuseFailure = { code: ReuseCode; repair?: boolean } | { core: string; repair?: boolean };

function reuseCodeText(t: TFunction<"gameFiles">, code: ReuseCode): string {
  switch (code) {
    case "registration_changed":
      return t("reuse.error.registrationChanged");
    case "profile_missing":
      return t("reuse.error.profileMissing");
    case "location_changed":
      return t("reuse.error.locationChanged");
  }
}

export function RegisteredSourceSetup({
  sources,
  profiles,
  statuses,
  generation,
  current,
  perform,
  onChanged,
  onOpenPort,
}: {
  sources: SourceRecord[];
  profiles: SourceProfile[];
  statuses: ReadonlyMap<string, PortStatus>;
  generation: number;
  current: boolean;
  perform: Perform;
  onChanged: () => Promise<unknown>;
  onOpenPort: (id: string, origin: string) => void;
}) {
  const { t } = useAppTranslation("gameFiles");
  const [selected, setSelected] = useState("");
  const [read, setRead] = useState<{ baseline: string; review: SourceReuseReview }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReuseFailure>();
  const [repairedPath, setRepairedPath] = useState<string>();
  const { requestReview } = useSetupReviewSelection();
  const source = sources.find((item) => item.profile_id === selected);
  const baseline = JSON.stringify([generation, source, current]);
  const owner = useRef<string | undefined>(undefined);
  const flight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedRead = useRef<typeof read>(undefined);
  useLayoutEffect(() => {
    owner.current = baseline;
    return () => {
      owner.current = undefined;
    };
  }, [baseline]);
  const review = read?.baseline === baseline ? read.review : undefined;
  useLayoutEffect(() => {
    if (review && read !== focusedRead.current && owner.current === baseline) {
      heading.current?.focus();
      focusedRead.current = read;
    }
  }, [baseline, read, review]);
  const run = async (operation: (accepts: () => boolean) => Promise<void>) => {
    if (!source || !current || flight.current) return;
    const accepts = () => owner.current === baseline;
    flight.current = true;
    setBusy(true);
    setError(undefined);
    setRepairedPath(undefined);
    try {
      await operation(accepts);
    } catch (value) {
      if (accepts())
        setError(value instanceof ReuseError ? { code: value.code } : { core: errorText(value) });
    } finally {
      flight.current = false;
      if (owner.current !== undefined) setBusy(false);
    }
  };
  const check = () =>
    run(async (accepts) => {
      const result = await desktopApi.reviewSourceReuse(selected, generation);
      if (!accepts()) return;
      if (JSON.stringify(result.registration) !== JSON.stringify(source))
        throw new ReuseError("registration_changed", reuseCodeText(t, "registration_changed"));
      setRead({ baseline, review: result });
    });
  const repair = () =>
    run(async (accepts) => {
      const profile = profiles.find((item) => item.id === selected);
      if (!profile || !source)
        throw new ReuseError("profile_missing", reuseCodeText(t, "profile_missing"));
      const path = await pickSourcePath(profile, source.path, "game");
      if (!path || !accepts()) return;
      const repaired = await perform(
        "repair game-file location",
        async () => {
          const plan = await desktopApi.planSourceRelink(selected, path, generation);
          if (JSON.stringify(plan.original) !== JSON.stringify(source))
            throw new ReuseError("location_changed", reuseCodeText(t, "location_changed"));
          return desktopApi.relinkSource(selected, path, plan.preview_sha256, generation);
        },
        {
          context: targetInvocationContext(
            "Repair game-file location",
            { kind: "source", id: source.profile_id, label: profile.label },
            generation,
            "library",
          ),
          refresh: "none",
          propagateFailure: true,
        },
      ).catch((value: unknown) => {
        if (accepts())
          setError(
            value instanceof ReuseError
              ? { code: value.code, repair: true }
              : { core: errorText(value), repair: true },
          );
        return undefined;
      });
      if (!repaired) return;
      if (accepts()) {
        setRead(undefined);
        setRepairedPath(repaired.path);
      }
      await onChanged();
    });
  if (!sources.length) return null;
  return (
    <section
      aria-label={t("reuse.label")}
      className="my-4 grid min-w-0 grid-cols-1 gap-3 wrap-anywhere"
    >
      <h2>{t("reuse.heading")}</h2>
      <p>{t("reuse.intro")}</p>
      <label className="min-w-0">
        {t("reuse.select")}
        <select
          className="w-full max-w-full min-w-0"
          data-focusable
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setError(undefined);
            setRepairedPath(undefined);
            setRead(undefined);
          }}
        >
          <option value="">{t("reuse.choose")}</option>
          {sources.map((item) => (
            <option key={item.profile_id} value={item.profile_id}>
              {profiles.find((profile) => profile.id === item.profile_id)?.label ?? item.profile_id}{" "}
              — {item.path}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          data-focusable
          disabled={!source || !current || busy}
          aria-busy={busy}
          focusableWhenDisabled={Boolean(source) && current && busy}
          onClick={() => void check()}
        >
          {t("reuse.check")}
        </Button>
        <Button
          data-focusable
          variant="outline"
          disabled={!source || !current || busy}
          onClick={() => void repair()}
          focusableWhenDisabled={Boolean(source) && current && busy}
        >
          {t("reuse.repair")}
        </Button>
      </div>
      {!current && <p role="status">{t("reuse.refreshFirst")}</p>}
      {error && (
        <p role="alert">
          {error.repair ? (
            <Trans
              t={t}
              i18nKey="reuse.error.repairFailed"
              components={{
                core: <>{"code" in error ? reuseCodeText(t, error.code) : error.core}</>,
              }}
            />
          ) : "code" in error ? (
            reuseCodeText(t, error.code)
          ) : (
            error.core
          )}
        </p>
      )}
      {repairedPath && (
        <p role="status">
          <Trans t={t} i18nKey="reuse.repaired" components={{ path: <bdi>{repairedPath}</bdi> }} />
        </p>
      )}
      {review && (
        <div aria-live="polite">
          <h3 ref={heading} tabIndex={-1}>
            {t("reuse.choosePort")}
          </h3>
          <p>{review.inspection.summary}</p>
          <p>{review.inspection.next_action}</p>
          {!review.applications.length && <p>{t("reuse.noPorts")}</p>}
          {review.applications.map((application) => {
            const status = statuses.get(application.port_id);
            const available =
              application.can_review_setup &&
              !status?.active &&
              !status?.external_runtime &&
              status?.port_actions?.some(
                (action) => action.action === "install" && action.availability === "allowed",
              );
            return (
              <article
                key={`${application.port_id}:${application.role}`}
                className="my-3 grid gap-2"
              >
                <h4>{application.port_name}</h4>
                <p>{application.summary}</p>
                <ul>
                  {application.additional_checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
                {available && (
                  <Button
                    data-focusable
                    disabled={busy || !current}
                    onClick={() => {
                      requestReview(application.port_id, status!.channel, review.reference);
                      onOpenPort(application.port_id, "add-games:saved-source");
                    }}
                  >
                    <Trans
                      t={t}
                      i18nKey="reuse.reviewSetup"
                      components={{ name: <bdi>{application.port_name}</bdi> }}
                    />
                  </Button>
                )}
                <Button
                  data-focusable
                  variant="outline"
                  disabled={busy || !current}
                  onClick={() => onOpenPort(application.port_id, "add-games:saved-source")}
                >
                  <Trans
                    t={t}
                    i18nKey="reuse.viewRequirements"
                    components={{ name: <bdi>{application.port_name}</bdi> }}
                  />
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
