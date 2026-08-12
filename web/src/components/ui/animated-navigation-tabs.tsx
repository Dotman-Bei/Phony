"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export type NavTabItem = {
  id: number;
  tile: string;
  href: string;
};

type Props = {
  items: NavTabItem[];
  className?: string;
  /** Accessible name for the landmark. */
  label?: string;
};

/**
 * Animated navigation tabs — a sliding underline that follows the active route, plus a
 * second bar and a soft fill that track the pointer.
 *
 * Adapted from the reference component in four ways, each forced by this being real site
 * navigation rather than a tab demo:
 *
 * 1. **Active state comes from the route, not `useState`.** The reference owns its
 *    selection internally, which would leave the underline stranded on the first tab after
 *    a back/forward navigation or a direct page load.
 * 2. **`<Link>` instead of `<button>`, wrapped in `<li>`.** Navigation must be a real
 *    anchor — middle-click, open-in-new-tab, and crawlability all depend on it — and a
 *    `<ul>` may only contain `<li>`, which the reference violates.
 * 3. **No `<main>` wrapper or `min-h-screen`.** That was demo chrome; a nav that claims
 *    the main landmark and a full viewport of height would break the page outline.
 * 4. **Motion respects `prefers-reduced-motion`.** The stylesheet's blanket reduced-motion
 *    rule only kills CSS animation; layout animations are driven by JS and have to opt out
 *    themselves.
 *
 * The shared `layoutId`s are what make the bars slide between tabs rather than fade, so
 * they must stay unique to this one mounted instance.
 */
export function AnimatedNavigationTabs({ items, className, label = "Primary" }: Props) {
  const pathname = usePathname();
  const [isHover, setIsHover] = useState<NavTabItem | null>(null);
  const reduceMotion = useReducedMotion();

  const active =
    items.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)) ?? null;

  const transition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 380, damping: 32, mass: 0.6 };

  return (
    <nav className={cn("relative", className)} aria-label={label}>
      <ul className="flex items-center justify-center" onMouseLeave={() => setIsHover(null)}>
        {items.map((item) => {
          const isActive = active?.id === item.id;

          return (
            <li key={item.id} className="relative">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative block py-2 transition-colors duration-300 hover:!text-primary",
                  isActive ? "text-primary" : "text-muted-foreground",
                )}
                onMouseEnter={() => setIsHover(item)}
                onFocus={() => setIsHover(item)}
                onBlur={() => setIsHover(null)}
              >
                <span className="relative block px-5 py-2 text-sm font-medium tracking-[-0.14px]">
                  {isHover?.id === item.id && (
                    <motion.span
                      layoutId="nav-hover-bg"
                      transition={transition}
                      className="absolute inset-0 block bg-primary/10"
                      style={{ borderRadius: 6 }}
                    />
                  )}
                  {/* Above the fill, so the label never sits under a tinted panel. */}
                  <span className="relative">{item.tile}</span>
                </span>

                {isActive && (
                  <motion.span
                    layoutId="nav-active"
                    transition={transition}
                    className="absolute bottom-0 left-0 right-0 block h-0.5 bg-primary"
                  />
                )}

                {isHover?.id === item.id && !isActive && (
                  <motion.span
                    layoutId="nav-hover"
                    transition={transition}
                    className="absolute bottom-0 left-0 right-0 block h-0.5 bg-primary/40"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
