"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { controlClassName, floatingMotion } from "./control-style";

import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

const overlayClassName =
  "fixed inset-0 z-(--layer-floating) bg-pc-scrim transition-opacity duration-(--duration-slow) ease-(--ease-standard) data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";
const popupClassName = cn(
  "fixed top-1/2 left-1/2 z-(--layer-floating) grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-pc-lg border border-pc-border bg-pc-surface p-4 text-sm text-pc-foreground shadow-(--shadow-floating) outline-none sm:max-w-sm forced-colors:outline-1 forced-colors:outline-solid",
  floatingMotion,
);

// Review surfaces share their scrolling and spacing; unusual compositions stay local.
const reviewLayoutClassName =
  "max-h-[calc(100dvh-var(--space-8))] max-w-none [scroll-padding-block:var(--space-4)] [overflow-wrap:anywhere] gap-0 overflow-y-auto overscroll-contain p-8 sm:max-w-none";
const reviewWidths = {
  compact: "w-[min(500px,90vw)]",
  standard: "w-[min(680px,90vw)]",
  wide: "w-[min(760px,90vw)]",
  large: "w-[min(860px,90vw)]",
};

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={controlClassName(overlayClassName, className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  portaled = true,
  finalFocus,
  reviewSize,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  portaled?: boolean;
  reviewSize?: keyof typeof reviewWidths;
}) {
  const content = (
    <>
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={<Button variant="ghost" className="absolute end-2 top-2" size="icon-sm" />}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </>
  );
  const layoutClassName = cn(
    popupClassName,
    reviewSize && reviewLayoutClassName,
    reviewSize && reviewWidths[reviewSize],
  );
  const resolvedClassName = controlClassName(layoutClassName, className);
  if (!portaled)
    return (
      <>
        <div data-slot="dialog-overlay" className={overlayClassName} />
        <div
          role="dialog"
          data-slot="dialog-content"
          data-portcove-focus-scope=""
          className={typeof resolvedClassName === "string" ? resolvedClassName : layoutClassName}
          {...(props as React.ComponentProps<"div">)}
        >
          {content}
        </div>
      </>
    );
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-portcove-focus-scope=""
        className={resolvedClassName}
        finalFocus={finalFocus}
        {...props}
      >
        {content}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col gap-2 rounded-b-pc-lg border-t border-pc-border bg-pc-surface-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={controlClassName(
        "m-0 pe-8 font-pc-heading text-lg leading-tight font-medium",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={controlClassName(
        "m-0 text-sm text-pc-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-pc-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
