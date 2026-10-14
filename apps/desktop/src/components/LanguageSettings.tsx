import { useEffect, useId, useRef, useState } from "react";
import { localeOptions, useLocalization } from "../localization";
import { ChoiceSelect } from "./ChoiceSelect";

export function LanguageSettings() {
  const localization = useLocalization();
  const { choice, locale, saving, saved, error } = localization;
  const triggerId = useId();
  const restoreFocusAfterSave = useRef(false);
  const selectionPopup = useRef<Element | null>(null);
  const [popupClosed, setPopupClosed] = useState(true);
  useEffect(() => {
    const cancelOnMovedFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target !== document.body &&
        target.id !== triggerId &&
        !selectionPopup.current?.contains(target)
      ) {
        restoreFocusAfterSave.current = false;
      }
    };
    document.addEventListener("focusin", cancelOnMovedFocus);
    return () => {
      restoreFocusAfterSave.current = false;
      document.removeEventListener("focusin", cancelOnMovedFocus);
    };
  }, [triggerId]);
  useEffect(() => {
    if (saving || !popupClosed || !restoreFocusAfterSave.current) return;
    const trigger = document.getElementById(triggerId);
    if (!(trigger instanceof HTMLButtonElement)) return;
    const restore = () => {
      if (!restoreFocusAfterSave.current || !trigger.isConnected || trigger.disabled) return;
      if (
        document.activeElement === document.body ||
        (document.activeElement && selectionPopup.current?.contains(document.activeElement))
      )
        trigger.focus();
      restoreFocusAfterSave.current = false;
      observer.disconnect();
    };
    // Select synchronizes disabled through its store after the parent commit.
    // Keep the intent until the actual button is ready, rather than consuming it early.
    const observer = new MutationObserver(restore);
    observer.observe(trigger, { attributes: true, attributeFilter: ["disabled"] });
    restore();
    return () => observer.disconnect();
  }, [saving, popupClosed, triggerId]);
  const options = [
    ...localeOptions.map((option) => ({
      value: option.value,
      label: localization.t(option.value === "system" ? "language.system" : "language.english"),
    })),
    ...(choice === "ar-XB"
      ? [{ value: "ar-XB" as const, label: localization.t("language.engineering") }]
      : []),
  ];
  const resolvedLanguage = localization.t(
    locale === "ar-XB" ? "language.engineering" : "language.english",
  );

  return (
    <article className="settings-row language-card" data-focus-group>
      <p className="eyebrow">{localization.t("language.eyebrow")}</p>
      <h2>{localization.t("language.title")}</h2>
      <p>{localization.t("language.description")}</p>
      <ChoiceSelect
        triggerId={triggerId}
        label={localization.t("language.pickerLabel")}
        value={choice}
        options={options}
        disabled={saving}
        onOpenChange={() => setPopupClosed(false)}
        onOpenChangeComplete={(open) => setPopupClosed(!open)}
        onChange={(nextChoice) => {
          selectionPopup.current =
            document.activeElement?.closest('[data-slot="select-content"]') ?? null;
          restoreFocusAfterSave.current = true;
          void localization.select(nextChoice);
        }}
      />
      <p>{localization.t("language.current", { language: resolvedLanguage })}</p>
      {locale === "ar-XB" && (
        <div role="note">
          <strong>{localization.t("language.previewTitle")}</strong>
          <p>{localization.t("language.previewDescription")}</p>
        </div>
      )}
      <p role="status" aria-live="polite">
        {saving
          ? localization.t("language.saving")
          : error === "load"
            ? localization.t("language.loadFailed", { language: resolvedLanguage })
            : error === "save"
              ? localization.t("language.saveFailed")
              : error === "apply"
                ? localization.t("language.applyFailed")
                : saved
                  ? localization.t("language.saved")
                  : ""}
      </p>
    </article>
  );
}
