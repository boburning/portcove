import { useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { backgroundObjectPosition, type BackgroundPreviewProps } from "../hero-media";
import type { ArtworkFraming } from "../types";
import { Button } from "./ui/button";
import styles from "./Artwork.module.css";

const defaultPoint = { x: 5000, y: 3500 };
const frames = [
  ["wide", "Wide preview"],
  ["narrow", "Narrow preview"],
] as const;
const axes = [
  ["x", "Horizontal"],
  ["y", "Vertical"],
] as const;

export function BackgroundFramingEditor({
  image,
  port,
  Preview,
  previewActions,
  sourceLabel,
  initialFraming,
  pending,
  stale,
  onApply,
  onCancel,
}: {
  image: string;
  port: BackgroundPreviewProps["port"];
  Preview: ComponentType<BackgroundPreviewProps>;
  previewActions?: Partial<Record<BackgroundPreviewProps["layout"], string>> | undefined;
  sourceLabel?: string | undefined;
  initialFraming: ArtworkFraming | null;
  pending: boolean;
  stale: boolean;
  onApply: (framing: ArtworkFraming | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreApplyFocus = useRef(false);
  const [framing, setFraming] = useState(initialFraming);
  const [imageFailed, setImageFailed] = useState(false);
  useLayoutEffect(() => {
    if (!heading.current?.closest("[inert], [hidden]")) heading.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (pending || !restoreApplyFocus.current) return;
    restoreApplyFocus.current = false;
    const target = (stale || imageFailed ? cancelButton : applyButton).current;
    if (!target?.closest("[inert], [hidden]")) target?.focus();
  }, [pending, stale, imageFailed]);
  return (
    <form
      className={styles.framingEditor}
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && !stale && !imageFailed) {
          restoreApplyFocus.current = true;
          onApply(framing);
        }
      }}
    >
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        Review Background
      </h3>
      {sourceLabel && <p>{sourceLabel}</p>}
      <div className={styles.framingPreviews}>
        {frames.map(([layout, label]) => {
          const point = framing?.[layout] ?? defaultPoint;
          return (
            <fieldset
              key={layout}
              className={styles.framingPreview}
              disabled={pending || stale || imageFailed}
            >
              <legend>{label}</legend>
              {!imageFailed && (
                <Preview
                  port={port}
                  layout={layout}
                  image={image}
                  position={backgroundObjectPosition(point)}
                  actionLabel={previewActions?.[layout]}
                  onError={() => setImageFailed(true)}
                />
              )}
              {axes.map(([axis, axisLabel]) => (
                <div key={axis} className={styles.framingAxis}>
                  <label htmlFor={`${id}-${layout}-${axis}`}>{axisLabel}</label>
                  <input
                    id={`${id}-${layout}-${axis}`}
                    name={`${layout}-${axis}`}
                    type="range"
                    dir="ltr"
                    data-focusable
                    data-controller-range
                    min={0}
                    max={10000}
                    step={1}
                    value={point[axis]}
                    aria-valuetext={`${point[axis] / 100}%`}
                    onInput={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      setFraming((current) => ({
                        version: "v1",
                        wide: current?.wide ?? defaultPoint,
                        narrow: current?.narrow ?? defaultPoint,
                        [layout]: { ...(current?.[layout] ?? defaultPoint), [axis]: value },
                      }));
                    }}
                  />
                </div>
              ))}
            </fieldset>
          );
        })}
      </div>
      {stale && <p role="alert">The artwork changed. Cancel and preview the image again.</p>}
      {imageFailed && (
        <p role="alert">The preview could not be displayed. Cancel and choose the image again.</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          ref={applyButton}
          data-focusable
          type="submit"
          disabled={pending || stale || imageFailed}
        >
          Apply
        </Button>
        <Button
          ref={cancelButton}
          data-focusable
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          data-focusable
          type="button"
          variant="ghost"
          disabled={pending || stale || imageFailed}
          aria-disabled={!framing}
          onClick={() => {
            if (framing) setFraming(null);
          }}
        >
          Use default framing
        </Button>
      </div>
    </form>
  );
}
