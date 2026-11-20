import type { TFunction } from "i18next";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAppTranslation } from "../localization";
import type {
  GameSettingChange,
  GameSettingsChangeSetReview,
  GameSettingsChangeSetView,
  GameSettingsEdit,
  GameSettingsView,
  GameSettingView,
} from "../types";
import { failurePresentation } from "../view-model";
import { useActionReview } from "../use-action-review";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const MAX_CHANGES_PER_REVIEW = 16;

type FileView = GameSettingsView["files"][number];
type DraftValue = { action: "set"; input: string } | { action: "reset" };
type FieldError = "tooLarge" | "whole" | "number" | "choose" | "range";
type Draft = { identity: string; values: Map<string, DraftValue> };

export interface GameSettingsActions {
  review: (fileId: string, edits: GameSettingsEdit[]) => Promise<GameSettingsChangeSetReview>;
  apply: (review: GameSettingsChangeSetReview) => Promise<GameSettingsView>;
}

/** Presentation and user intent only; Core owns release eligibility and every edit. */
export function GameSettingsPanel({
  view,
  generation,
  actions,
  changed,
  disabled = false,
  fileReadRevisions,
}: {
  view: GameSettingsChangeSetView;
  generation: number;
  actions: GameSettingsActions;
  changed: (view: GameSettingsView) => void;
  disabled?: boolean;
  fileReadRevisions?: ReadonlyMap<string, number>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const heading = useRef<HTMLHeadingElement>(null);
  const { settings, setup } = view;
  const identity = JSON.stringify([
    generation,
    settings.port_id,
    settings.install_id,
    settings.available,
    setup?.id,
    setup?.revision,
  ]);
  return (
    <section aria-label={t("panel.label")} className="grid gap-4">
      <header>
        <h3 ref={heading} tabIndex={-1} className="m-0 text-sm font-semibold">
          {t("panel.heading")}
        </h3>
        <SettingsTarget view={view} />
        <p className="mt-1 text-xs text-pc-muted-foreground">{t("panel.intro")}</p>
      </header>
      {!settings.available && <p role="status">{settings.reason ?? t("panel.unavailable")}</p>}
      {settings.files.map((file) => (
        <SettingsFileDraft
          key={file.id}
          file={file}
          identity={JSON.stringify([identity, file.id, file.configuration_sha256, file.available])}
          view={view}
          actions={actions}
          changed={changed}
          disabled={disabled || !settings.available}
          heading={heading}
          readRevision={fileReadRevisions?.get(file.id) ?? 0}
        />
      ))}
    </section>
  );
}

function SettingsTarget({ view }: { view: GameSettingsChangeSetView }) {
  const { t } = useAppTranslation("gameSettings");
  if (!view.settings.available || !view.installed_version) return null;
  return (
    <p className="mt-1 text-xs wrap-anywhere text-pc-muted-foreground [unicode-bidi:plaintext]">
      {view.setup_name
        ? t("panel.setupTarget", { setup: view.setup_name, version: view.installed_version })
        : t("panel.installTarget", { version: view.installed_version })}
    </p>
  );
}

function SettingsFileDraft({
  file,
  identity,
  view,
  actions,
  changed,
  disabled,
  heading,
  readRevision,
}: {
  file: FileView;
  identity: string;
  view: GameSettingsChangeSetView;
  actions: GameSettingsActions;
  changed: (view: GameSettingsView) => void;
  disabled: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  readRevision: number;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState<{ identity: string; edits: GameSettingsEdit[] }>();
  const [error, setError] = useState<{ id: string; kind: FieldError }>();
  const [savedAtRead, setSavedAtRead] = useState<number>();
  const [failed, setFailed] = useState<{ read: number; committed: boolean }>();
  const needsRead = failed?.read === readRevision;
  const reviewButton = useRef<HTMLButtonElement>(null);
  const held = draft !== undefined && draft.identity !== identity;
  const available = file.available && Boolean(file.configuration_sha256);
  const activeReview = selected?.identity === identity && available ? selected : undefined;
  if (selected && selected.identity !== identity) setSelected(undefined);
  const values = draft?.values;
  const count = values?.size ?? 0;
  const update = (id: string, value?: DraftValue) => {
    setError(undefined);
    setSavedAtRead(undefined);
    setDraft((previous) => {
      const next = new Map(previous?.values);
      if (value) next.set(id, value);
      else next.delete(id);
      return next.size ? { identity, values: next } : undefined;
    });
  };
  const submit = (form: HTMLFormElement) => {
    if (disabled || needsRead || held || !available || !count || count > MAX_CHANGES_PER_REVIEW)
      return;
    const edits: GameSettingsEdit[] = [];
    for (const setting of file.settings) {
      const value = values?.get(setting.id);
      if (!value) continue;
      const result = parseChange(setting, value);
      if (typeof result === "string") {
        setError({ id: setting.id, kind: result });
        const element = form.elements.namedItem(setting.id);
        if (element instanceof HTMLElement) element.focus();
        return;
      }
      edits.push({ setting_id: setting.id, change: result });
    }
    setError(undefined);
    setSelected({ identity, edits });
  };
  return (
    <form
      noValidate
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <h4 className="m-0 text-sm font-medium wrap-anywhere">{file.path}</h4>
      {!available && <p role="status">{file.reason ?? t("panel.fileUnavailable")}</p>}
      {held && (
        <div>
          <p role="status">{t("panel.held")}</p>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              setDraft(undefined);
              setError(undefined);
            }}
          >
            {t("panel.discard")}
          </Button>
        </div>
      )}
      {needsRead && !activeReview && (
        <p role="status">{t(failed?.committed ? "review.savedReadback" : "review.failure")}</p>
      )}
      {savedAtRead === readRevision && <p role="status">{t("review.saved")}</p>}
      {(available || held) && (
        <fieldset
          disabled={disabled || held || needsRead}
          className="m-0 grid min-w-0 gap-3 border-0 p-0"
        >
          {file.settings.map((setting) => (
            <SettingEditor
              key={setting.id}
              setting={setting}
              draft={values?.get(setting.id)}
              error={error?.id === setting.id ? error.kind : undefined}
              edit={(value) => update(setting.id, value)}
            />
          ))}
          {count > MAX_CHANGES_PER_REVIEW && <p role="status">{t("panel.limit")}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={reviewButton}
              type="submit"
              variant="primary"
              disabled={needsRead || !count || count > MAX_CHANGES_PER_REVIEW}
            >
              {t("editor.review")}
            </Button>
            {count > 0 && !held && (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  setDraft(undefined);
                  setError(undefined);
                }}
              >
                {t("panel.discard")}
              </Button>
            )}
          </div>
        </fieldset>
      )}
      {activeReview && (
        <SettingReview
          key={identity}
          view={view}
          file={file}
          identity={identity}
          edits={activeReview.edits}
          actions={actions}
          changed={(next) => {
            setDraft(undefined);
            setSavedAtRead(readRevision);
            changed(next);
          }}
          failed={(failure) => {
            const committed = failurePresentation(failure)?.mutation_state === "committed";
            setFailed({ read: readRevision, committed });
            if (committed) setDraft(undefined);
          }}
          disabled={disabled || needsRead}
          close={() => setSelected(undefined)}
          returnFocus={reviewButton}
          heading={heading}
        />
      )}
    </form>
  );
}

function currentInput(setting: GameSettingView, reset = false): string {
  const type = setting.value_type;
  const value = reset ? type.default : (setting.value ?? type.default);
  if (type.kind === "enum")
    return String(
      type.choices.findIndex((item) => JSON.stringify(item.value) === JSON.stringify(value)),
    );
  return String(value);
}

function parseChange(setting: GameSettingView, draft: DraftValue): GameSettingChange | FieldError {
  if (draft.action === "reset") return draft;
  const type = setting.value_type;
  if (type.kind === "boolean") return { action: "set", value: draft.input === "true" };
  if (type.kind === "enum") {
    const choice = type.choices[Number(draft.input)];
    return choice ? { action: "set", value: choice.value } : "choose";
  }
  const value = draft.input.trim() === "" ? NaN : Number(draft.input);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return "tooLarge";
  if (type.kind === "integer" && !Number.isInteger(value)) return "whole";
  if (!Number.isFinite(value)) return "number";
  if (value < type.minimum || value > type.maximum) return "range";
  return { action: "set", value };
}

function SettingEditor({
  setting,
  draft,
  error,
  edit,
}: {
  setting: GameSettingView;
  draft?: DraftValue;
  error?: FieldError;
  edit: (value?: DraftValue) => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const id = useId();
  const type = setting.value_type;
  const input =
    draft?.action === "set" ? draft.input : currentInput(setting, draft?.action === "reset");
  const update = (input: string) =>
    edit(input === currentInput(setting) ? undefined : { action: "set", input });
  const field = {
    id,
    name: setting.id,
    "aria-invalid": error !== undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  };
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {setting.label}
      </label>
      {type.kind === "boolean" ? (
        <input
          {...field}
          type="checkbox"
          checked={input === "true"}
          onChange={(event) => update(String(event.target.checked))}
        />
      ) : type.kind === "enum" ? (
        <select {...field} value={input} onChange={(event) => update(event.target.value)}>
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
          {...field}
          type="number"
          value={input}
          min={type.minimum}
          max={type.maximum}
          step={type.step}
          onChange={(event) => update(event.target.value)}
        />
      )}
      {draft?.action === "reset" && (
        <p className="m-0 text-xs text-pc-muted-foreground">{t("editor.pendingDefault")}</p>
      )}
      {setting.value == null && !draft && (
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
                : error === "range"
                  ? t("editor.error.range")
                  : t("editor.error.choose")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" type="button" onClick={() => edit({ action: "reset" })}>
          {t("editor.reset")}
        </Button>
        {draft && (
          <Button variant="outline" type="button" onClick={() => edit()}>
            {t("editor.undo")}
          </Button>
        )}
      </div>
    </div>
  );
}

function SettingReview({
  view,
  file,
  identity,
  edits,
  actions,
  changed,
  failed,
  disabled,
  close,
  returnFocus,
  heading,
}: {
  view: GameSettingsChangeSetView;
  file: FileView;
  identity: string;
  edits: GameSettingsEdit[];
  actions: GameSettingsActions;
  changed: (view: GameSettingsView) => void;
  failed: (error: unknown) => void;
  disabled: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const title = useRef<HTMLHeadingElement>(null);
  const active = useRef(true);
  const focusTarget = useRef<"review" | "heading">(undefined);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const description = useId();
  const { preview, pending, error, failurePhase, review, execute, dismiss } = useActionReview({
    identity,
    load: async () => {
      const result = await actions.review(file.id, edits);
      if (
        result.port_id !== view.settings.port_id ||
        result.install_id !== view.settings.install_id ||
        result.file_id !== file.id ||
        result.path !== file.path ||
        result.configuration_sha256 !== file.configuration_sha256 ||
        result.setup?.id !== view.setup?.id ||
        result.setup?.revision !== view.setup?.revision ||
        result.edits.length !== edits.length ||
        edits.some(({ setting_id, change }, index) => {
          const actual = result.edits[index]?.edit;
          return (
            actual?.setting_id !== setting_id ||
            actual.change.action !== change.action ||
            (actual.change.action === "set" &&
              change.action === "set" &&
              actual.change.value !== change.value)
          );
        })
      )
        throw new Error(t("review.installationChanged"));
      return result;
    },
    apply: async (result) => {
      try {
        const updated = await actions.apply(result);
        if (active.current) {
          focusTarget.current = "heading";
          changed(updated);
        }
        return true;
      } catch (failure) {
        if (active.current) {
          focusTarget.current = "heading";
          failed(failure);
        }
        throw failure;
      }
    },
    close: () => {
      focusTarget.current ??= "review";
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
        finalFocus={() =>
          focusTarget.current === "heading"
            ? heading.current
            : focusTarget.current === "review"
              ? returnFocus.current
              : false
        }
        showCloseButton={false}
        aria-describedby={description}
      >
        <DialogTitle ref={title} tabIndex={-1}>
          {t("review.title")}
        </DialogTitle>
        <DialogDescription id={description}>{t("review.description")}</DialogDescription>
        <SettingsTarget view={view} />
        {pending === "review" && <p role="status">{t("review.reading")}</p>}
        {preview && (
          <div className="grid gap-3">
            <p className="m-0 text-xs wrap-anywhere">{preview.path}</p>
            {preview.edits.map((item) => {
              const setting = file.settings.find(({ id }) => id === item.edit.setting_id);
              return (
                <div key={item.edit.setting_id} className="grid gap-1 wrap-anywhere">
                  <h3 className="m-0 text-sm font-medium">{item.label}</h3>
                  <dl className="grid grid-cols-2 gap-2">
                    <div>
                      <dt>{t("review.current")}</dt>
                      <dd>{settingValueLabel(t, item.previous_value, setting)}</dd>
                    </div>
                    <div>
                      <dt>
                        {item.edit.change.action === "reset"
                          ? t("review.default")
                          : t("review.new")}
                      </dt>
                      <dd>{settingValueLabel(t, item.proposed_value, setting)}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
        {preview && (
          <details>
            <summary data-focusable>{t("review.technical")}</summary>
            <dl className="grid gap-2 wrap-anywhere">
              {preview.edits.map(({ edit, label, previous_value, proposed_value }) => (
                <div key={edit.setting_id}>
                  <dt>{label}</dt>
                  <dd>
                    <code>{JSON.stringify(previous_value ?? null)}</code>
                    {" → "}
                    <code>{JSON.stringify(proposed_value)}</code>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <Button type="button" disabled={pending === "apply"} onClick={dismiss}>
            {t("review.cancel")}
          </Button>
          {!preview && !pending && failurePhase !== "apply" && (
            <Button type="button" onClick={() => void review()}>
              {t("review.again")}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={disabled || !preview || Boolean(pending)}
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
