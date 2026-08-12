import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn `cn` helper: conditional class composition with Tailwind conflict resolution,
 * so a later `text-primary` wins over an earlier `text-muted-foreground` instead of both
 * landing in the class list and letting source order in the stylesheet decide.
 *
 * This project writes its own semantic CSS rather than composing utilities, so `cn` is
 * only used by components under `components/ui` that arrive expecting it.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
