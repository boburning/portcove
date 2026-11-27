import { useId, useState, type FormEvent } from "react";
import { desktopApi } from "../api";
import { pickHostToolExecutable, pickInstallFolder } from "../file-picker";
import type { ExternalRuntimePreview } from "../types";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function PersonalUpstreamRegistration({
  generation,
  onAdded,
}: {
  generation: number;
  onAdded: () => Promise<unknown>;
}) {
  const addressId = useId();
  const [url, setUrl] = useState("");
  const [executable, setExecutable] = useState("");
  const [directory, setDirectory] = useState("");
  const [review, setReview] = useState<ExternalRuntimePreview>();
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<unknown>();

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setReview(undefined);
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !executable || !directory) return;
    void run(async () => {
      if (!review) {
        setReview(
          await desktopApi.previewPersonalGithubRuntime(url, executable, directory, generation),
        );
        return;
      }
      const saved = await desktopApi.registerPersonalGithubRuntime(
        url,
        executable,
        directory,
        review.preview_sha256,
        generation,
      );
      if (saved) {
        setReview(undefined);
        setAdded(true);
        await onAdded();
      }
    });
  };

  if (added) {
    return (
      <div>
        <p role="status">Port added to your library.</p>
        <ActionReviewFailure error={error} />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <fieldset disabled={pending} className="grid gap-3">
        <div className="grid gap-1">
          <label htmlFor={addressId}>Public GitHub project address</label>
          <Input
            id={addressId}
            type="url"
            required
            value={url}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
              setReview(undefined);
            }}
          />
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void run(async () => {
                const path = await pickHostToolExecutable("game", executable);
                if (typeof path === "string") {
                  setExecutable(path);
                  setDirectory(
                    path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1),
                  );
                  setReview(undefined);
                }
              })
            }
          >
            Choose executable
          </Button>
          {executable && <p className="break-all">{executable}</p>}
        </div>
        {executable && (
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void run(async () => {
                  const path = await pickInstallFolder(directory);
                  if (typeof path === "string") {
                    setDirectory(path);
                    setReview(undefined);
                  }
                })
              }
            >
              Change start folder
            </Button>
            {directory && <p className="break-all">{directory}</p>}
          </div>
        )}
        {review && (
          <p role="status" className="break-all">
            Review ready. Portcove will use {review.executable} where it is.
          </p>
        )}
        <Button type="submit" variant="primary" disabled={!executable || !directory}>
          {review ? "Add port" : "Review registration"}
        </Button>
      </fieldset>
      <ActionReviewFailure error={error} />
    </form>
  );
}
