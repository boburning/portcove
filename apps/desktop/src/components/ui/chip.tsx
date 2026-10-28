import type { ComponentProps } from "react";
import { cn } from "cn";
import { Check } from "lucide-react";
import { Button } from "./button";

export function Chip({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("identity-chip", className)} {...props} />;
}

export function ChipButton({ children, className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn("identity-chip identity-chip-button", className)}
      {...props}
    >
      {props["aria-pressed"] === true && <Check aria-hidden="true" />}
      {children}
    </Button>
  );
}
