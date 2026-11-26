import { useEffect, useId, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { pickModRecipePath, saveModRecipePath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { RecipeImportReview } from "../transport-types.generated";
import { errorText } from "../view-model";
import { providerName } from "./ModProviderBrowser";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Props = {
  portId: string;
  profileId: string | undefined;
  generation: number;
  disabled: boolean;
  openGameFiles: (() => void) | undefined;
  onBusyChange: (busy: boolean) => void;
  onImported: (message: string) => void;
};

type RecipeAction = "export" | "open" | "import" | "close" | `provider:${string}`;

export function ModRecipeControl({
  portId,
  profileId,
  generation,
  disabled,
  openGameFiles,
  onBusyChange,
  onImported,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [review, setReview] = useState<RecipeImportReview>();
  const plan = review?.plan;
  const [allowCode, setAllowCode] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<RecipeAction>();
  const [pausePending, setPausePending] = useState(false);
  const pauseAfterStep = useRef(false);
  const pauseTrigger = useRef<HTMLButtonElement>(null);
  const returnToRecipe = useRef(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const nameId = useId();
  const reviewTitle = useId();
  const locked = disabled || pending !== undefined;
  const openButton = useRef<HTMLButtonElement>(null);
  const reviewSection = useRef<HTMLElement>(null);
  const focusOpenOnClose = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusReviewFrom = useRef<HTMLElement | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [portId, generation]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const showReview = (next?: RecipeImportReview, trigger: HTMLElement | null = null) => {
    focusReviewFrom.current = document.activeElement === trigger ? trigger : null;
    setReview(next);
  };
  useEffect(() => {
    const trigger = focusReviewFrom.current;
    focusReviewFrom.current = null;
    const heading = reviewHeading.current;
    if (!plan || !heading || !trigger) return;
    const active = document.activeElement;
    if (active !== trigger && (active !== document.body || trigger.isConnected)) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start", inline: "nearest" });
  }, [plan]);
  useEffect(() => {
    if (plan || locked || !focusOpenOnClose.current) return;
    focusOpenOnClose.current = false;
    if (document.activeElement === document.body) openButton.current?.focus();
  }, [plan, locked]);

  useEffect(() => {
    if (pending || !returnToRecipe.current) return;
    returnToRecipe.current = false;
    if (document.activeElement === document.body) reviewHeading.current?.focus();
  }, [pending]);

  function actionState(action: RecipeAction) {
    const active = pending === action;
    return { disabled: locked, focusableWhenDisabled: active, "aria-busy": active };
  }

  async function run(kind: RecipeAction, action: () => Promise<void>) {
    setPending(kind);
    onBusyChange(true);
    try {
      await action();
    } catch (error) {
      if (active.current) {
        setNotice(undefined);
        setFailure(errorText(error));
      }
    } finally {
      if (active.current) {
        if (kind === "provider:all" && document.activeElement === pauseTrigger.current) {
          returnToRecipe.current = true;
        }
        setPending(undefined);
        onBusyChange(false);
      }
    }
  }

  const exportRecipe = () => {
    if (!profileId) return;
    void run("export", async () => {
      const path = await saveModRecipePath(t("mods.recipe.savePicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string" || !active.current) return;
      setFailure(undefined);
      await desktopApi.exportModRecipe(portId, profileId, path, generation);
      setNotice(t("mods.recipe.saved"));
    });
  };

  const closeReview = async () => {
    if (review && plan?.acquisitions?.length) {
      await desktopApi.discardModRecipeReview(portId, review, generation);
    }
    if (!active.current) return;
    focusOpenOnClose.current = reviewSection.current?.contains(document.activeElement) ?? false;
    showReview();
    setAllowCode(false);
  };

  const inspectRecipe = () =>
    void run("open", async () => {
      const path = await pickModRecipePath(t("mods.recipe.openPicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string" || !active.current) return;
      setFailure(undefined);
      setNotice(undefined);
      // Identical recipes can share the same staged files across views. Only
      // an explicit close discards a review. Core prunes abandoned staging.
      showReview();
      setAllowCode(false);
      const review = await desktopApi.inspectModRecipe(portId, path, generation);
      if (!active.current) return;
      showReview(review, openButton.current);
      setName("");
    });

  const checkProvider = (nativeId: string, trigger: HTMLButtonElement) => {
    if (!review || !plan || !profileId) return;
    void run(`provider:${nativeId}`, async () => {
      setFailure(undefined);
      setAllowCode(false);
      const nextReview = await desktopApi.acquireModRecipePackage(
        portId,
        profileId,
        nativeId,
        review,
        generation,
      );
      if (!active.current) return;
      showReview(nextReview, trigger);
    });
  };

  // Stages every missing package in bounded steps. Each step is recorded by
  // Core, so a stop or restart keeps what was already checked.
  const checkAllProviders = (trigger: HTMLButtonElement) => {
    if (!review || !plan || !profileId) return;
    void run("provider:all", async () => {
      setFailure(undefined);
      setAllowCode(false);
      setPausePending(false);
      pauseAfterStep.current = false;
      const total = plan.provider_checks?.length ?? 0;
      let current = review;
      let done = 0;
      for (;;) {
        const step = await desktopApi.acquireModRecipePackages(
          portId,
          profileId,
          current,
          generation,
        );
        if (!active.current) return;
        current = step.review;
        done += step.acquired.length;
        showReview(current, trigger);
        setNotice(t("mods.recipe.checkedSoFar", { done, total }));
        if (step.failure) {
          setFailure(
            t("mods.recipe.checkStopped", {
              name: step.failure.native_id,
              reason: step.failure.message,
            }),
          );
          return;
        }
        if (step.acquired.length === 0 || !current.plan.provider_checks?.length) return;
        if (pauseAfterStep.current) {
          setNotice(t("mods.recipe.checksPaused", { done, total }));
          return;
        }
      }
    });
  };

  const needsCode = Boolean(plan?.code_approval?.length);
  const exactProviderChecks = new Set(plan?.provider_checks);
  const packageProviders = new Map(
    plan?.recipe.packages.map((pack) => [pack.native_id, pack.provider]),
  );
  const importRecipe = () => {
    if (!review || !plan?.can_apply || !name.trim() || (needsCode && !allowCode)) return;
    void run("import", async () => {
      setFailure(undefined);
      await desktopApi.applyModRecipe(portId, name.trim(), review, generation, allowCode);
      if (!active.current) return;
      focusOpenOnClose.current = reviewSection.current?.contains(document.activeElement) ?? false;
      showReview();
      setAllowCode(false);
      setName("");
      onImported(t("mods.recipe.imported", { name: name.trim() }));
    });
  };

  return (
    <div className="grid min-w-0 gap-2 wrap-anywhere">
      <div className="flex flex-wrap gap-2">
        {profileId && (
          <Button variant="outline" {...actionState("export")} onClick={exportRecipe}>
            {t("mods.recipe.export")}
          </Button>
        )}
        <Button ref={openButton} variant="outline" {...actionState("open")} onClick={inspectRecipe}>
          {t("mods.recipe.openPicker")}
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
      {plan && (
        <section
          ref={reviewSection}
          aria-labelledby={reviewTitle}
          className="grid min-w-0 gap-2 text-sm"
        >
          <h4
            ref={reviewHeading}
            id={reviewTitle}
            tabIndex={-1}
            className="scroll-mt-3 font-semibold"
          >
            {t("mods.recipe.review")}
          </h4>
          <p>{t(plan.can_apply ? "mods.recipe.ready" : "mods.recipe.held")}</p>
          <p>{t("mods.recipe.platform", { platform: plan.recipe.runtime.platform })}</p>
          {plan.originals.some((original) => original.status !== "available") && (
            <div className="grid gap-1">
              <p>{t("mods.recipe.originalNeeded")}</p>
              {openGameFiles && (
                <Button variant="outline" disabled={locked} onClick={openGameFiles}>
                  {t("mods.recipe.gameFiles")}
                </Button>
              )}
            </div>
          )}
          {plan.recipe.packages.length > 0 && (
            <ul className="list-disc ps-5" aria-label={t("mods.recipe.packages")}>
              {plan.recipe.packages.map((pack) => (
                <li key={pack.native_id}>
                  {t(pack.enabled ? "mods.recipe.enabled" : "mods.recipe.disabled", {
                    name: pack.native_id,
                  })}
                </li>
              ))}
            </ul>
          )}
          <details open={!plan.can_apply}>
            <summary>{t("mods.recipe.details")}</summary>
            <ul className="list-disc ps-5">
              {[plan.runtime, ...plan.originals].map((input, index) => (
                <li key={JSON.stringify([input.name, index])}>
                  <strong>{input.name}</strong> {input.detail}
                </li>
              ))}
              {plan.packages.map((input) => {
                const provider = exactProviderChecks.has(input.name)
                  ? packageProviders.get(input.name)
                  : undefined;
                return (
                  <li key={input.name}>
                    <strong>
                      <bdi>{input.name}</bdi>
                    </strong>{" "}
                    {provider?.file ? (
                      <Trans
                        t={t}
                        i18nKey="mods.recipe.providerFile"
                        components={{
                          provider: <bdi>{providerName(provider.provider)}</bdi>,
                          project: <bdi>{provider.project}</bdi>,
                          file: <bdi>{provider.file}</bdi>,
                        }}
                      />
                    ) : (
                      input.detail
                    )}
                  </li>
                );
              })}
              {[...new Set([...plan.holds, ...plan.recipe.uncaptured])].map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
            {plan.recipe.orderings.map((ordering) => (
              <div key={ordering.domain} className="mt-2">
                <p>{t("mods.recipe.order", { domain: ordering.domain })}</p>
                <ol className="list-decimal ps-5">
                  {ordering.native_ids.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ol>
              </div>
            ))}
            {Boolean(plan.recipe.settings?.length) && (
              <div className="mt-2">
                <p>{t("mods.recipe.settings")}</p>
                <ul className="list-disc ps-5">
                  {plan.recipe.settings?.map((setting, index) => (
                    <li key={JSON.stringify([setting.native_id, setting.option_id])}>
                      <bdi>
                        {t("mods.recipe.setting", {
                          mod: setting.native_id,
                          option: setting.option_id,
                        })}
                      </bdi>
                      {" · "}
                      <bdi>{review?.setting_values[index]}</bdi>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2">
              {t("mods.recipe.identity")}{" "}
              <code className="break-all" dir="ltr">
                {plan.recipe.identity_sha256}
              </code>
            </p>
          </details>
          {!profileId && Boolean(plan.provider_checks?.length) && (
            <p>{t("mods.recipe.providerSetupNeeded")}</p>
          )}
          {profileId && (plan.provider_checks?.length ?? 0) > 1 && (
            <Button
              variant="outline"
              {...actionState("provider:all")}
              onClick={(event) => checkAllProviders(event.currentTarget)}
            >
              {t("mods.recipe.checkAllProviders")}
            </Button>
          )}
          {pending === "provider:all" && (
            <Button
              ref={pauseTrigger}
              variant="outline"
              disabled={pausePending}
              focusableWhenDisabled
              onClick={() => {
                pauseAfterStep.current = true;
                setPausePending(true);
                setNotice(t("mods.recipe.finishingStep"));
              }}
            >
              {t("mods.recipe.pauseChecks")}
            </Button>
          )}
          {profileId &&
            plan.provider_checks?.map((nativeId) => (
              <Button
                key={nativeId}
                variant="outline"
                {...actionState(`provider:${nativeId}`)}
                onClick={(event) => checkProvider(nativeId, event.currentTarget)}
              >
                {t("mods.recipe.checkProvider", { name: nativeId })}
              </Button>
            ))}
          {plan.can_apply && needsCode && (
            <div className="grid gap-1">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={allowCode}
                  disabled={locked}
                  onChange={(event) => setAllowCode(event.currentTarget.checked)}
                />
                {t("mods.recipe.allowCode")}
              </label>
              <ul className="list-disc ps-5">
                {plan.code_approval?.map((code) => (
                  <li key={code.native_id}>
                    {code.native_id}{" "}
                    <code className="break-all" dir="ltr">
                      {code.sha256}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.can_apply && (
            <div className="grid gap-1">
              <label htmlFor={nameId}>{t("mods.recipe.name")}</label>
              <Input
                id={nameId}
                type="text"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                disabled={locked}
                maxLength={128}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {plan.can_apply && (
              <Button
                {...actionState("import")}
                disabled={locked || !name.trim() || (needsCode && !allowCode)}
                onClick={importRecipe}
              >
                {t("mods.recipe.import")}
              </Button>
            )}
            <Button
              variant="outline"
              {...actionState("close")}
              onClick={() => void run("close", closeReview)}
            >
              {t("mods.recipe.close")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
