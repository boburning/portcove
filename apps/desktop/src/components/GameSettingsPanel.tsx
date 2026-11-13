import type { TFunction } from "i18next";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAppTranslation } from "../localization";
import type {
  GameSettingReview,
  GameSettingsView,
  GameSettingView,
  GameSettingChange,
} from "../types";
import { useActionReview } from "../use-action-review";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

type Change = GameSettingChange;
type Intent = { fileId: string; settingId: string; change: Change };

export interface GameSettingsActions {
  review: (fileId: string, settingId: string, change: Change) => Promise<GameSettingReview>;
  apply: (review: GameSettingReview) => Promise<GameSettingsView>;
}

/** Presentation and user intent only; Core owns release eligibility and every edit. */
export function GameSettingsPanel({
  view,
  generation,
  actions,
  changed,
}: {
  view: GameSettingsView;
  generation: number;
  actions: GameSettingsActions;
  changed: (view: GameSettingsView) => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [selection, setSelection] = useState<{ identity: string; intent: Intent }>();
  const returnFocus = useRef<HTMLHeadingElement>(null);
  const identity = JSON.stringify([
    generation,
    view.port_id,
    view.install_id,
    view.available,
    view.files,
  ]);
  if (selection && selection.identity !== identity) setSelection(undefined);
  const intent = selection?.identity === identity ? selection.intent : undefined;
  return (
    <section aria-label={t("panel.label")} className="grid gap-4">
      <header>
        <h3 ref={returnFocus} tabIndex={-1} className="m-0 text-sm font-semibold">
          {t("panel.heading")}
        </h3>
        <p className="mt-1 text-xs text-pc-muted-foreground">{t("panel.intro")}</p>
      </header>
      {!view.available && <p role="status">{view.reason ?? t("panel.unavailable")}</p>}
      {view.available &&
        view.files.map((file) => (
          <div key={file.id} className="grid gap-3">
            {!file.available && <p role="status">{file.reason ?? t("panel.fileUnavailable")}</p>}
            {file.available &&
              file.settings.map((setting) => (
                <SettingEditor
                  key={JSON.stringify([identity, file.id, setting.id])}
                  setting={setting}
                  review={(change) =>
                    setSelection({
                      identity,
                      intent: { fileId: file.id, settingId: setting.id, change },
                    })
                  }
                />
              ))}
          </div>
        ))}
      {intent && (
        <SettingReview
          key={JSON.stringify([identity, intent])}
          view={view}
          identity={identity}
          intent={intent}
          actions={actions}
          changed={changed}
          close={() => setSelection(undefined)}
          returnFocus={returnFocus}
        />
      )}
    </section>
  );
}

function SettingEditor({
  setting,
  review,
}: {
  setting: GameSettingView;
  review: (change: Change) => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const id = useId();
  const type = setting.value_type;
  const initial = setting.value ?? type.default;
  const [text, setText] = useState(typeof initial === "number" ? String(initial) : "");
  const [checked, setChecked] = useState(initial === true);
  const [choice, setChoice] = useState(
    type.kind === "enum"
      ? String(
          type.choices.findIndex((item) => JSON.stringify(item.value) === JSON.stringify(initial)),
        )
      : "-1",
  );
  // App-owned validation codes are translated at render.
  const [error, setError] = useState<"tooLarge" | "whole" | "number" | "choose">();
  const submit = () => {
    let value: unknown;
    if (type.kind === "boolean") value = checked;
    else if (type.kind === "enum") value = type.choices[Number(choice)]?.value;
    else {
      value = text.trim() === "" ? NaN : Number(text);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (type.kind === "integer" && !Number.isSafeInteger(value))
      ) {
        setError(
          typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
            ? "tooLarge"
            : type.kind === "integer"
              ? "whole"
              : "number",
        );
        return;
      }
    }
    if (value === undefined) {
      setError("choose");
      return;
    }
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      setError("tooLarge");
      return;
    }
    setError(undefined);
    review({ action: "set", value });
  };
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {setting.label}
      </label>
      {type.kind === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
      ) : type.kind === "enum" ? (
        <select id={id} value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="-1" disabled>
            {t("editor.chooseValue")}
          </option>
          {type.choices.map((item, index) => (
            <option key={index} value={index}>
              {item.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type="number"
          value={text}
          min={type.minimum}
          max={type.maximum}
          step={type.step}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setError(undefined);
          }}
        />
      )}
      {setting.value == null && (
        <p className="m-0 text-xs text-pc-muted-foreground">{t("editor.defaultShown")}</p>
      )}
      {(type.kind === "number" || type.kind === "integer") && (
        <p className="m-0 text-xs text-pc-muted-foreground">
          {t(type.kind === "integer" ? "editor.rangeWhole" : "editor.rangeNumber", {
            minimum: type.minimum,
            maximum: type.maximum,
            step: type.step,
          })}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert">
          {error === "tooLarge"
            ? t("editor.error.tooLarge")
            : error === "whole"
              ? t("editor.error.whole")
              : error === "number"
                ? t("editor.error.number")
                : t("editor.error.choose")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={submit}>{t("editor.review")}</Button>
        <Button onClick={() => review({ action: "reset" })}>{t("editor.reset")}</Button>
      </div>
    </div>
  );
}

function SettingReview({
  view,
  identity,
  intent,
  actions,
  changed,
  close,
  returnFocus,
}: {
  view: GameSettingsView;
  identity: string;
  intent: Intent;
  actions: GameSettingsActions;
  changed: (view: GameSettingsView) => void;
  close: () => void;
  returnFocus: RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const title = useRef<HTMLHeadingElement>(null);
  const active = useRef(true);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const description = useId();
  const setting = view.files
    .find((file) => file.id === intent.fileId)
    ?.settings.find((item) => item.id === intent.settingId);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([identity, intent]),
    load: async () => {
      const result = await actions.review(intent.fileId, intent.settingId, intent.change);
      if (
        result.port_id !== view.port_id ||
        result.install_id !== view.install_id ||
        result.file_id !== intent.fileId ||
        result.setting_id !== intent.settingId
      ) {
        // Thrown text is read by the shared failure presentation, so it is already translated.
        throw new Error(t("review.installationChanged"));
      }
      return result;
    },
    apply: async (result) => {
      const updated = await actions.apply(result);
      if (active.current) {
        restoreFocus.current = true;
        changed(updated);
      }
      return true;
    },
    close: () => {
      restoreFocus.current = true;
      close();
    },
    failureMessage: t("review.failure"),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        initialFocus={title}
        finalFocus={() => (restoreFocus.current ? returnFocus.current : false)}
        showCloseButton={false}
        aria-describedby={description}
      >
        <DialogTitle ref={title} tabIndex={-1}>
          {t("review.title")}
        </DialogTitle>
        <DialogDescription id={description}>{t("review.description")}</DialogDescription>
        {pending === "review" && <p role="status">{t("review.reading")}</p>}
        {preview && (
          <dl className="grid gap-2">
            <dt>{t("review.setting")}</dt>
            <dd>{preview.label}</dd>
            <dt>{t("review.current")}</dt>
            <dd>{settingValueLabel(t, preview.previous_value, setting)}</dd>
            <dt>{intent.change.action === "reset" ? t("review.default") : t("review.new")}</dt>
            <dd>{settingValueLabel(t, preview.proposed_value, setting)}</dd>
          </dl>
        )}
        {preview && (
          <details>
            <summary data-focusable>{t("review.technical")}</summary>
            <dl className="grid gap-2 wrap-anywhere">
              <dt>{t("review.current")}</dt>
              <dd>
                <code>{JSON.stringify(preview.previous_value ?? null)}</code>
              </dd>
              <dt>{t("review.new")}</dt>
              <dd>
                <code>{JSON.stringify(preview.proposed_value)}</code>
              </dd>
            </dl>
          </details>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <Button disabled={pending === "apply"} onClick={dismiss}>
            {t("review.cancel")}
          </Button>
          {!preview && !pending && (
            <Button onClick={() => void review()}>{t("review.again")}</Button>
          )}
          <Button
            variant="primary"
            disabled={!preview || Boolean(pending)}
            aria-busy={pending === "apply"}
            onClick={() => void execute()}
          >
            {t("review.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function settingValueLabel(
  t: TFunction<"gameSettings">,
  value: unknown,
  setting: GameSettingView | undefined,
) {
  if (value == null) return t("value.notSaved");
  const type = setting?.value_type;
  if (type?.kind === "enum") {
    const choice = type.choices.find(
      (item) => JSON.stringify(item.value) === JSON.stringify(value),
    );
    if (choice) return choice.label;
    return t("value.unrecognized");
  }
  if (typeof value === "boolean") return value ? t("value.on") : t("value.off");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : t("value.unavailable");
}
