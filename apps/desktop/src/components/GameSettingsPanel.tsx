import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
    <section aria-label="Game settings" className="grid gap-4">
      <header>
        <h3 ref={returnFocus} tabIndex={-1} className="m-0 text-sm font-semibold">
          Game settings
        </h3>
        <p className="mt-1 text-xs text-pc-muted-foreground">
          Review each change before saving. Other preferences stay as they are.
        </p>
      </header>
      {!view.available && (
        <p role="status">{view.reason ?? "Settings are unavailable for this installation."}</p>
      )}
      {view.available &&
        view.files.map((file) => (
          <div key={file.id} className="grid gap-3">
            {!file.available && (
              <p role="status">{file.reason ?? "This settings file is unavailable."}</p>
            )}
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
  const [error, setError] = useState<string>();
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
        setError("Enter a supported finite value.");
        return;
      }
    }
    if (
      value === undefined ||
      (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      setError("Choose a supported value.");
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
            Choose a value
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
        <p className="m-0 text-xs text-pc-muted-foreground">
          Not saved yet; showing the verified default.
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={submit}>Review change</Button>
        <Button onClick={() => review({ action: "reset" })}>Review default</Button>
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
        throw new Error("The installation changed. Refresh settings and review again.");
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
    failureMessage: "The change was not accepted. Refresh settings and review again.",
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
          Review game setting
        </DialogTitle>
        <DialogDescription id={description}>
          Save this one preference for the installed game. The game may need to restart to use it.
        </DialogDescription>
        {pending === "review" && <p role="status">Reading the current setting…</p>}
        {preview && (
          <dl className="grid gap-2">
            <dt>Setting</dt>
            <dd>{preview.label}</dd>
            <dt>Current saved value</dt>
            <dd>
              {preview.previous_value == null
                ? "Not saved"
                : JSON.stringify(preview.previous_value)}
            </dd>
            <dt>{intent.change.action === "reset" ? "Verified default" : "Proposed value"}</dt>
            <dd>{JSON.stringify(preview.proposed_value)}</dd>
          </dl>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <Button disabled={pending === "apply"} onClick={dismiss}>
            Cancel
          </Button>
          {!preview && !pending && <Button onClick={() => void review()}>Review again</Button>}
          <Button
            variant="primary"
            disabled={!preview || Boolean(pending)}
            aria-busy={pending === "apply"}
            onClick={() => void execute()}
          >
            Save setting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
