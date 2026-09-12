import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { LatestRequestGeneration } from "../concurrency-state";
import type { ApplicationUpdateChoice, ApplicationUpdatePreferences } from "../types";
import { errorText } from "../view-model";

const recommendedChoice: ApplicationUpdateChoice = {
  channel: "preview",
  mode: "automatic",
  paused: false,
};

function choicesMatch(left: ApplicationUpdateChoice | null, right: ApplicationUpdateChoice) {
  return (
    left?.channel === right.channel && left.mode === right.mode && left.paused === right.paused
  );
}

export function ApplicationUpdateSettings({
  currentVersion,
  disabled = false,
}: {
  currentVersion: string;
  disabled?: boolean;
}) {
  const requests = useRef(new LatestRequestGeneration());
  const [preferences, setPreferences] = useState<ApplicationUpdatePreferences>();
  const [draft, setDraft] = useState<ApplicationUpdateChoice>(recommendedChoice);
  const [busy, setBusy] = useState("Loading application update settings…");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const applyPreferences = (value: ApplicationUpdatePreferences) => {
    setPreferences(value);
    setDraft(value.choice ?? recommendedChoice);
  };

  const load = async () => {
    const request = requests.current.begin();
    setBusy("Loading application update settings…");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.applicationUpdatePreferences();
      if (requests.current.isCurrent(request)) applyPreferences(value);
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(errorText(value));
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  useEffect(() => {
    const requestTracker = requests.current;
    const request = requestTracker.begin();
    void desktopApi
      .applicationUpdatePreferences()
      .then((value) => {
        if (requestTracker.isCurrent(request)) {
          setPreferences(value);
          setDraft(value.choice ?? recommendedChoice);
        }
      })
      .catch((value: unknown) => {
        if (requestTracker.isCurrent(request)) setError(errorText(value));
      })
      .finally(() => {
        if (requestTracker.isCurrent(request)) setBusy("");
      });
    return () => {
      requestTracker.begin();
    };
  }, []);

  const save = async () => {
    if (!preferences || choicesMatch(preferences.choice, draft)) return;
    const request = requests.current.begin();
    setBusy("Saving application update settings…");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.setApplicationUpdatePreferences(preferences.revision, draft);
      if (!requests.current.isCurrent(request)) return;
      applyPreferences(value);
      setNotice(
        "Application update settings saved. No update check, download, install, or restart was started.",
      );
    } catch (value) {
      if (!requests.current.isCurrent(request)) return;
      const message = errorText(value);
      try {
        const current = await desktopApi.applicationUpdatePreferences();
        if (requests.current.isCurrent(request)) {
          applyPreferences(current);
          setError(`${message} Current settings were refreshed; review them before saving again.`);
        }
      } catch {
        if (requests.current.isCurrent(request)) setError(message);
      }
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const reset = async () => {
    if (!preferences?.choice) return;
    const request = requests.current.begin();
    setBusy("Clearing the saved application update choice…");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.resetApplicationUpdatePreferences();
      if (!requests.current.isCurrent(request)) return;
      applyPreferences(value);
      setNotice("Saved choice cleared. Automatic application update checks remain off.");
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(errorText(value));
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const unavailable = disabled || Boolean(busy) || !preferences;
  const changed = Boolean(preferences && !choicesMatch(preferences.choice, draft));

  return (
    <article
      className="settings-card application-update-settings"
      data-focus-group
      aria-labelledby="application-update-settings-title"
      aria-busy={Boolean(busy)}
    >
      <div className="application-update-heading">
        <div>
          <p className="eyebrow">APPLICATION UPDATES</p>
          <h2 id="application-update-settings-title">Choose how Portcove updates</h2>
        </div>
        <p>
          Current version <strong>{currentVersion}</strong>
        </p>
      </div>

      {!preferences && !busy && (
        <button
          data-focusable
          className="small-control"
          disabled={disabled}
          onClick={() => void load()}
        >
          Retry loading settings
        </button>
      )}

      {preferences && (
        <>
          {!preferences.choice && (
            <p className="application-update-consent">
              No application update choice is saved. Automatic checks remain off until you save one.
            </p>
          )}

          <section
            className="application-update-choice"
            aria-labelledby="application-channel-label"
          >
            <h3 id="application-channel-label">Channel</h3>
            <div className="segmented" role="group" aria-label="Application update channel">
              {(["preview", "stable"] as const).map((channel) => (
                <button
                  key={channel}
                  data-focusable
                  className={draft.channel === channel ? "active" : ""}
                  aria-pressed={draft.channel === channel}
                  disabled={unavailable}
                  onClick={() => setDraft((value) => ({ ...value, channel }))}
                >
                  {channel === "preview" ? "Preview" : "Stable"}
                </button>
              ))}
            </div>
            <p>
              {draft.channel === "preview"
                ? "Preview receives public test releases and later eligible final releases."
                : "Stable waits for an eligible production release that is newer than your installed version; it never downgrades Portcove."}
            </p>
          </section>

          <section className="application-update-choice" aria-labelledby="application-mode-label">
            <h3 id="application-mode-label">Update mode</h3>
            <div className="segmented" role="group" aria-label="Application update mode">
              {(
                [
                  ["automatic", "Automatic"],
                  ["notify-only", "Notify only"],
                  ["manual", "Manual"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  data-focusable
                  className={draft.mode === mode ? "active" : ""}
                  aria-pressed={draft.mode === mode}
                  disabled={unavailable}
                  onClick={() => setDraft((value) => ({ ...value, mode }))}
                >
                  {label}
                  {mode === "automatic" && <small>Recommended</small>}
                </button>
              ))}
            </div>
            <p>
              {draft.mode === "automatic"
                ? "Allows Portcove to check and stage verified updates without asking for each release. Applying still waits for a safe exit or an explicit Restart to update action."
                : draft.mode === "notify-only"
                  ? "Checks for eligible updates and tells you when one is available. Downloading and applying require explicit actions."
                  : "Does not check automatically. Use Check for updates when you want to look for a release."}
            </p>
          </section>

          <div className="application-update-pause">
            <input
              data-focusable
              id="pause-application-updates"
              type="checkbox"
              aria-describedby="pause-application-updates-description"
              checked={draft.paused}
              disabled={unavailable}
              onChange={(event) =>
                setDraft((value) => ({ ...value, paused: event.target.checked }))
              }
            />
            <span>
              <label htmlFor="pause-application-updates">Pause application update activity</label>
              <small id="pause-application-updates-description">
                Keep this choice, but do not check or stage updates until resumed.
              </small>
            </span>
          </div>

          <p className="application-update-disclosure">
            Saving changes only stores this preference. It does not check, download, install, or
            restart Portcove.
          </p>
          <div className="actions compact">
            <button
              data-focusable
              className="primary"
              disabled={unavailable || !changed}
              onClick={() => void save()}
            >
              Save application update settings
            </button>
            <button
              data-focusable
              disabled={unavailable || !changed}
              onClick={() => setDraft(preferences.choice ?? recommendedChoice)}
            >
              Discard changes
            </button>
            <button
              data-focusable
              disabled={unavailable || !preferences.choice}
              onClick={() => void reset()}
            >
              Clear saved choice
            </button>
          </div>
        </>
      )}

      {busy && <p role="status">{busy}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
