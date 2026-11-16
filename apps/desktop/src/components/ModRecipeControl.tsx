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
  onBusyChange: (busy: boolean) => void;
  onImported: (message: string) => void;
};

export function ModRecipeControl({
  portId,
  profileId,
  generation,
  disabled,
  onBusyChange,
  onImported,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [plan, setPlan] = useState<OutputRecipeImportPlan>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const nameId = useId();
  const reviewTitle = useId();
  const locked = disabled || busy;
  const openButton = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (plan) reviewHeading.current?.focus();
  }, [plan]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange(true);
    try {
      await action();
    } catch (error) {
      setNotice(undefined);
      setFailure(errorText(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  const exportRecipe = () => {
    if (!profileId) return;
    void run(async () => {
      const path = await saveModRecipePath(t("mods.recipe.savePicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string") return;
      setFailure(undefined);
      await desktopApi.exportModRecipe(portId, profileId, path, generation);
      setNotice(t("mods.recipe.saved"));
    });
  };

  const inspectRecipe = () =>
    void run(async () => {
      const path = await pickModRecipePath(t("mods.recipe.openPicker"), t("mods.recipe.fileType"));
      if (typeof path !== "string") return;
      setFailure(undefined);
      setNotice(undefined);
      setPlan(undefined);
      const review = await desktopApi.inspectModRecipe(portId, path, generation);
      setPlan(review);
      setName("");
    });

  const importRecipe = () => {
    if (!plan?.can_apply || !name.trim()) return;
    void run(async () => {
      setFailure(undefined);
      await desktopApi.applyModRecipe(portId, name.trim(), plan, generation);
      setPlan(undefined);
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
            <p className="mt-2">
              {t("mods.recipe.identity")}{" "}
              <code className="break-all" dir="ltr">
                {plan.recipe.identity_sha256}
              </code>
            </p>
          </details>
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
              <Button disabled={locked || !name.trim()} onClick={importRecipe}>
                {t("mods.recipe.import")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => {
                setPlan(undefined);
                openButton.current?.focus();
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
