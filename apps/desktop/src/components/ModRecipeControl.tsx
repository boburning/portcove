import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickModRecipePath, saveModRecipePath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { OutputRecipeImportPlan } from "../transport-types.generated";
import { errorText } from "../view-model";
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
  const [plan, setPlan] = useState<OutputRecipeImportPlan>();
  const [allowCode, setAllowCode] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const nameId = useId();
  const reviewTitle = useId();
  const locked = disabled || busy;
  const openButton = useRef<HTMLButtonElement>(null);
  const focusOpenOnClose = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const lifecycle = useRef({
    active: true,
    review: undefined as OutputRecipeImportPlan | undefined,
  });
  useEffect(() => {
    const view = lifecycle.current;
    view.active = true;
    return () => {
      view.active = false;
      const review = view.review;
      view.review = undefined;
      if (review?.acquisitions?.length) {
        void desktopApi.discardModRecipeReview(portId, review, generation).catch(() => {});
      }
    };
  }, [portId, generation]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const showReview = (next?: OutputRecipeImportPlan) => {
    lifecycle.current.review = next;
    setPlan(next);
  };
  useEffect(() => {
    if (plan) reviewHeading.current?.focus();
  }, [plan]);
  useEffect(() => {
    if (plan || locked || !focusOpenOnClose.current) return;
    focusOpenOnClose.current = false;
    openButton.current?.focus();
  }, [plan, locked]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange(true);
    try {
      await action();
    } catch (error) {
      if (lifecycle.current.active) {
        setNotice(undefined);
        setFailure(errorText(error));
      }
    } finally {
      if (lifecycle.current.active) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  const exportRecipe = () => {
    if (!profileId) return;
    void run(async () => {
      const path = await saveModRecipePath(t("mods.recipe.savePicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string" || !lifecycle.current.active) return;
      setFailure(undefined);
      await desktopApi.exportModRecipe(portId, profileId, path, generation);
      setNotice(t("mods.recipe.saved"));
    });
  };

  const discardReview = async () => {
    if (plan?.acquisitions?.length) {
      await desktopApi.discardModRecipeReview(portId, plan, generation);
    }
    showReview();
    setAllowCode(false);
  };

  const inspectRecipe = () =>
    void run(async () => {
      const path = await pickModRecipePath(t("mods.recipe.openPicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string" || !lifecycle.current.active) return;
      setFailure(undefined);
      setNotice(undefined);
      await discardReview();
      const review = await desktopApi.inspectModRecipe(portId, path, generation);
      if (!lifecycle.current.active) return;
      showReview(review);
      setName("");
    });

  const checkProvider = (nativeId: string) => {
    if (!plan || !profileId) return;
    void run(async () => {
      setFailure(undefined);
      setAllowCode(false);
      const review = await desktopApi.acquireModRecipePackage(
        portId,
        profileId,
        nativeId,
        plan,
        generation,
      );
      if (!lifecycle.current.active) {
        await desktopApi.discardModRecipeReview(portId, review, generation).catch(() => {});
        return;
      }
      showReview(review);
    });
  };

  const needsCode = Boolean(plan?.code_approval?.length);
  const importRecipe = () => {
    if (!plan?.can_apply || !name.trim() || (needsCode && !allowCode)) return;
    void run(async () => {
      setFailure(undefined);
      await desktopApi.applyModRecipe(portId, name.trim(), plan, generation, allowCode);
      if (!lifecycle.current.active) return;
      showReview();
      setAllowCode(false);
      setName("");
      onImported(t("mods.recipe.imported", { name: name.trim() }));
    });
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {profileId && (
          <Button variant="outline" disabled={locked} onClick={exportRecipe}>
            {t("mods.recipe.export")}
          </Button>
        )}
        <Button ref={openButton} variant="outline" disabled={locked} onClick={inspectRecipe}>
          {t("mods.recipe.openPicker")}
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
      {plan && (
        <section aria-labelledby={reviewTitle} className="grid gap-2 text-sm">
          <h4 ref={reviewHeading} id={reviewTitle} tabIndex={-1} className="font-semibold">
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
            <ul className="list-disc pl-5" aria-label={t("mods.recipe.packages")}>
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
            <ul className="list-disc pl-5">
              {[plan.runtime, ...plan.originals, ...plan.packages].map((input, index) => (
                <li key={JSON.stringify([input.name, index])}>
                  <strong>{input.name}</strong> {input.detail}
                </li>
              ))}
              {[...new Set([...plan.holds, ...plan.recipe.uncaptured])].map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
            {plan.recipe.orderings.map((ordering) => (
              <div key={ordering.domain} className="mt-2">
                <p>{t("mods.recipe.order", { domain: ordering.domain })}</p>
                <ol className="list-decimal pl-5">
                  {ordering.native_ids.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ol>
              </div>
            ))}
            {Boolean(plan.recipe.settings?.length) && (
              <div className="mt-2">
                <p>{t("mods.recipe.settings")}</p>
                <ul className="list-disc pl-5">
                  {plan.recipe.settings?.map((setting) => (
                    <li key={JSON.stringify([setting.native_id, setting.option_id])}>
                      <bdi>
                        {t("mods.recipe.setting", {
                          mod: setting.native_id,
                          option: setting.option_id,
                        })}
                      </bdi>
                      {" · "}
                      <bdi>{String(setting.value)}</bdi>
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
          {profileId &&
            plan.provider_checks?.map((nativeId) => (
              <Button
                key={nativeId}
                variant="outline"
                disabled={locked}
                onClick={() => checkProvider(nativeId)}
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
              <ul className="list-disc pl-5">
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
                disabled={locked || !name.trim() || (needsCode && !allowCode)}
                onClick={importRecipe}
              >
                {t("mods.recipe.import")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => {
                if (!plan.acquisitions?.length) {
                  showReview();
                  setAllowCode(false);
                  openButton.current?.focus();
                  return;
                }
                void run(async () => {
                  await discardReview();
                  focusOpenOnClose.current = true;
                });
              }}
            >
              {t("mods.recipe.close")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
