import { useEffect, useId, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ModSetupRecoveryPlan, ModSetupRevision } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { ActionRow } from "./ui/patterns";

type Props = {
  portId: string;
  profileId: string;
  currentRevision: number;
  generation: number;
  locked: boolean;
  blocked: boolean;
  pendingCount?: number;
  onRestored?: () => void;
  perform: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
};

export function ModSetupRecovery({
  portId,
  profileId,
  currentRevision,
  generation,
  locked,
  blocked,
  pendingCount = 0,
  onRestored,
  perform,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const request = useRef({ id: 0 });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"history" | "review">();
  const [history, setHistory] = useState<ModSetupRevision[]>([]);
  const [error, setError] = useState<string>();
  const [plan, setPlan] = useState<ModSetupRecoveryPlan>();

  useEffect(() => {
    const tracker = request.current;
    return () => {
      tracker.id++;
    };
  }, []);
  useEffect(() => {
    if (plan) reviewHeading.current?.focus();
  }, [plan]);

  const close = () => {
    request.current.id++;
    setOpen(false);
    setPending(undefined);
    setPlan(undefined);
    setError(undefined);
  };

  const showHistory = async () => {
    const id = ++request.current.id;
    setOpen(true);
    setHistory([]);
    setError(undefined);
    setPending("history");
    try {
      const revisions = await desktopApi.modSetupRevisions(portId, profileId, generation);
      if (request.current.id !== id) return;
      if (
        revisions.some((entry) => entry.profile_id !== profileId || entry.build.port_id !== portId)
      ) {
        setError(t("mods.gameChanged"));
        return;
      }
      setHistory(
        revisions
          .filter((entry) => entry.revision < currentRevision)
          .sort((a, b) => b.revision - a.revision),
      );
    } catch (failure) {
      if (request.current.id === id) setError(errorText(failure));
    } finally {
      if (request.current.id === id) setPending(undefined);
    }
  };

  const review = async (revision: number) => {
    const id = ++request.current.id;
    setPlan(undefined);
    setError(undefined);
    setPending("review");
    try {
      const next = await desktopApi.planProfileRecovery(portId, profileId, revision, generation);
      if (request.current.id !== id) return;
      if (
        next.current.profile_id !== profileId ||
        next.current.build.port_id !== portId ||
        next.current.revision !== currentRevision ||
        next.target.profile_id !== profileId ||
        next.target.build.port_id !== portId ||
        next.target.revision !== revision
      ) {
        setError(t("mods.gameChanged"));
        return;
      }
      setPlan(next);
    } catch (failure) {
      if (request.current.id === id) setError(errorText(failure));
    } finally {
      if (request.current.id === id) setPending(undefined);
    }
  };

  const apply = async (reviewed: ModSetupRecoveryPlan) => {
    const id = request.current.id;
    const ok = await perform(
      () =>
        desktopApi.applyProfileRecovery(
          portId,
          profileId,
          reviewed.target.revision,
          reviewed.plan_sha256,
          generation,
        ),
      t("mods.recovery.applied"),
    );
    if (ok) onRestored?.();
    if (request.current.id !== id) return;
    if (ok) {
      close();
      toggle.current?.focus();
    } else {
      setPlan(undefined);
      reviewTrigger.current?.focus();
    }
  };

  return (
    <div className="grid gap-2">
      <ActionRow>
        <Button
          ref={toggle}
          variant="outline"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={locked && !open}
          onClick={() => {
            if (open) close();
            else void showHistory();
          }}
        >
          {open ? t("mods.recovery.hide") : t("mods.recovery.history")}
        </Button>
      </ActionRow>
      {open && (
        <div id={panelId} className="grid gap-3 rounded-pc-md border border-pc-border p-3">
          {pending && (
            <p role="status">
              {t(pending === "history" ? "mods.recovery.loading" : "mods.recovery.reviewing")}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {!pending && !error && history.length === 0 && <p>{t("mods.recovery.none")}</p>}
          <ul className="m-0 grid list-none gap-2 p-0">
            {history.map((entry) => (
              <li key={entry.revision}>
                <ActionRow>
                  <bdi className="text-sm break-all">{entry.build.artifact.asset_name}</bdi>
                  <Button
                    variant="outline"
                    disabled={locked || pending !== undefined}
                    onClick={(event) => {
                      reviewTrigger.current = event.currentTarget;
                      void review(entry.revision);
                    }}
                  >
                    {t("mods.recovery.review", { revision: entry.revision })}
                  </Button>
                </ActionRow>
              </li>
            ))}
          </ul>
          {plan && (
            <div className="grid gap-2 border-t border-pc-border pt-3">
              <h5 ref={reviewHeading} tabIndex={-1} className="text-sm font-semibold">
                {t("mods.recovery.title", { revision: plan.target.revision })}
              </h5>
              <dl className="grid gap-1 text-sm">
                <dt>{t("mods.recovery.currentRuntime")}</dt>
                <dd>
                  <bdi className="break-all">{plan.current.build.artifact.asset_name}</bdi>
                </dd>
                <dt>{t("mods.recovery.targetRuntime")}</dt>
                <dd>
                  <bdi className="break-all">{plan.target.build.artifact.asset_name}</bdi>
                </dd>
              </dl>
              <p className="text-sm">{t("mods.recovery.keepProgress")}</p>
              {plan.update_policy === "automatic_eligible" && (
                <p className="text-sm">{t("mods.recovery.automatic")}</p>
              )}
              {pendingCount > 0 && (
                <p role="status">{t("mods.workspace.restorePending", { count: pendingCount })}</p>
              )}
              <h6 className="font-semibold">{t("mods.workspace.currentMods")}</h6>
              <RecoveryPackages target={plan.current} />
              <h6 className="font-semibold">{t("mods.workspace.restoredMods")}</h6>
              <RecoveryPackages target={plan.target} />
              {plan.holds.length > 0 && (
                <div role="alert">
                  <p>{t("mods.recovery.held")}</p>
                  <ul>
                    {plan.holds.map((hold) => (
                      <li key={JSON.stringify(hold)}>
                        {hold.details?.package ? (
                          <Trans
                            t={t}
                            i18nKey="mods.recovery.holdPackage"
                            components={{
                              name: <bdi>{hold.details.package}</bdi>,
                              reason: <span>{hold.message}</span>,
                            }}
                          />
                        ) : (
                          hold.message
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <RecoveryDetails plan={plan} />
              <ActionRow>
                <Button
                  onClick={() => void apply(plan)}
                  disabled={locked || blocked || plan.holds.length > 0}
                >
                  {t("mods.recovery.apply")}
                </Button>
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    setPlan(undefined);
                    reviewTrigger.current?.focus();
                  }}
                >
                  {t("mods.recovery.cancel")}
                </Button>
              </ActionRow>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecoveryPackages({ target }: { target: ModSetupRevision }) {
  const { t } = useAppTranslation("gameSettings");
  const packages = target.packages ?? [];
  return packages.length ? (
    <ul aria-label={t("mods.recovery.packages")} className="grid gap-1 text-sm">
      {packages.map((pkg) => (
        <li key={pkg.native_id}>
          <Trans
            t={t}
            i18nKey={pkg.enabled ? "mods.recovery.enabled" : "mods.recovery.disabled"}
            components={{ name: <bdi>{pkg.native_id}</bdi> }}
          />
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm">{t("mods.recovery.noPackages")}</p>
  );
}

function RecoveryDetails({ plan }: { plan: ModSetupRecoveryPlan }) {
  const { t } = useAppTranslation("gameSettings");
  const originalStatus = {
    changed: t("mods.recovery.originalState.changed"),
    missing: t("mods.recovery.originalState.missing"),
    verified: t("mods.recovery.originalState.verified"),
  };
  return (
    <details className="grid gap-2 text-sm">
      <summary className="cursor-pointer">{t("mods.recovery.details")}</summary>
      <dl className="grid gap-1">
        {(plan.target.orderings ?? []).map((order) => (
          <div key={order.domain}>
            <dt>
              <Trans
                t={t}
                i18nKey="mods.recovery.order"
                components={{ domain: <bdi>{order.domain}</bdi> }}
              />
            </dt>
            <dd>
              <bdi>{order.native_ids.join(t("mods.separator"))}</bdi>
            </dd>
          </div>
        ))}
        {Object.entries(plan.target.settings ?? {}).map(([key, value]) => (
          <div key={key}>
            <dt>
              <bdi>{key}</bdi>
            </dt>
            <dd>
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
        {plan.originals.map(({ binding, availability }) => (
          <div key={binding.requirement_id}>
            <dt>
              <Trans
                t={t}
                i18nKey="mods.recovery.original"
                components={{ id: <bdi>{binding.requirement_id}</bdi> }}
              />
            </dt>
            <dd>{originalStatus[availability]}</dd>
          </div>
        ))}
        {(plan.target.limits ?? []).map((limit, index) => (
          <div key={index}>
            <dt>{t("mods.recovery.limit")}</dt>
            <dd>{limit}</dd>
          </div>
        ))}
        <div>
          <dt>{t("mods.recovery.digest")}</dt>
          <dd>
            <bdi className="break-all">{plan.plan_sha256}</bdi>
          </dd>
        </div>
      </dl>
    </details>
  );
}
