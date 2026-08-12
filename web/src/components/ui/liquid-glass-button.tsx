"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Liquid glass button.
 *
 * Three stacked layers make the effect: an inset box-shadow stack that fakes a bevelled
 * glass rim, a backdrop layer running an SVG turbulence + displacement filter so whatever
 * sits behind the button refracts through it, and the label floating above both.
 *
 * Adapted from the reference in four places:
 *
 * 1. **Pill radius throughout.** The reference mixes `rounded-full` on the rim with
 *    `rounded-md` on the backdrop and the button itself, so the glass refraction squares
 *    off inside a rounded rim. Everything is a pill here, which also matches this app's
 *    radius rule -- 999px for anything interactive.
 * 2. **Displacement scale dropped from 70 to 26.** That value is tuned for the reference's
 *    56px-tall demo button; at nav scale it smears a 40px control into noise.
 * 3. **The filter is rendered once, at the app root**, not inside every button. SVG filter
 *    ids are global, so N buttons meant N elements all claiming `#container-glass`.
 * 4. **`Button` and `MetalButton` are not included.** Neither is needed for this and both
 *    depend on ~10 shadcn tokens this project does not define (`bg-accent`, `bg-secondary`,
 *    `border-input`, ...), so their variants would render as unstyled buttons. Shipping a
 *    component that silently does nothing is worse than not shipping it.
 *
 * Browser support: `backdrop-filter: url()` is Chromium-only today. Elsewhere the
 * refraction is skipped and the bevelled rim carries the effect on its own, which is a
 * clean degradation rather than a broken control.
 */

export const GLASS_FILTER_ID = "container-glass";

export const liquidbuttonVariants = cva(
  "inline-flex items-center transition-colors justify-center cursor-pointer gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        default: "bg-transparent text-primary duration-300 transition motion-safe:hover:scale-105",
        foreground: "bg-transparent text-foreground duration-300 transition motion-safe:hover:scale-105",
        destructive: "bg-transparent text-destructive duration-300 transition motion-safe:hover:scale-105",
      },
      size: {
        sm: "h-8 text-xs gap-1.5 px-4 has-[>svg]:px-4",
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        lg: "h-10 px-6 has-[>svg]:px-4",
        xl: "h-12 px-8 has-[>svg]:px-6",
        xxl: "h-14 px-10 has-[>svg]:px-8",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "lg",
    },
  },
);

export function LiquidButton({
  className,
  variant,
  size,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof liquidbuttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn("relative", liquidbuttonVariants({ variant, size, className }))}
      {...props}
    >
      {/* The bevelled rim. Two inset shadow stacks -- one for light backgrounds, one for
          dark -- so the highlight always runs along the top-left and the shade along the
          bottom-right, whichever theme is behind it. */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 z-0 h-full w-full rounded-full transition-all
          shadow-[0_0_6px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3px_rgba(0,0,0,0.9),inset_-3px_-3px_0.5px_-3px_rgba(0,0,0,0.85),inset_1px_1px_1px_-0.5px_rgba(0,0,0,0.6),inset_-1px_-1px_1px_-0.5px_rgba(0,0,0,0.6),inset_0_0_6px_6px_rgba(0,0,0,0.12),inset_0_0_2px_2px_rgba(0,0,0,0.06),0_0_12px_rgba(255,255,255,0.15)]
          dark:shadow-[0_0_8px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3.5px_rgba(255,255,255,0.09),inset_-3px_-3px_0.5px_-3.5px_rgba(255,255,255,0.85),inset_1px_1px_1px_-0.5px_rgba(255,255,255,0.6),inset_-1px_-1px_1px_-0.5px_rgba(255,255,255,0.6),inset_0_0_6px_6px_rgba(255,255,255,0.12),inset_0_0_2px_2px_rgba(255,255,255,0.06),0_0_12px_rgba(0,0,0,0.15)]"
      />

      {/* The refraction. Isolated so the filter samples the page behind the button rather
          than compositing with its own siblings. */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 isolate -z-10 h-full w-full overflow-hidden rounded-full"
        style={{ backdropFilter: `url("#${GLASS_FILTER_ID}")` }}
      />

      <span className="pointer-events-none z-10 inline-flex items-center gap-2">{children}</span>
    </Comp>
  );
}

/**
 * The SVG filter the glass layer points at. Mount exactly once, near the app root.
 *
 * Kept out of the button so a page with several glass buttons does not end up with several
 * elements defining the same filter id -- the browser resolves duplicates to whichever it
 * saw first, which makes the effect quietly depend on render order.
 */
export function GlassFilter() {
  return (
    <svg className="hidden" aria-hidden="true" focusable="false">
      <defs>
        <filter
          id={GLASS_FILTER_ID}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.05 0.05"
            numOctaves="1"
            seed="1"
            result="turbulence"
          />
          <feGaussianBlur in="turbulence" stdDeviation="2" result="blurredNoise" />
          {/* 26, not the reference's 70: this button is 40px tall, and at 70 the
              displacement is larger than the control and reads as static. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="blurredNoise"
            scale="26"
            xChannelSelector="R"
            yChannelSelector="B"
            result="displaced"
          />
          <feGaussianBlur in="displaced" stdDeviation="1.4" result="finalBlur" />
          <feComposite in="finalBlur" in2="finalBlur" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}
