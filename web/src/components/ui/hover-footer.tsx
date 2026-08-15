"use client";

import React, { useRef, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Cursor-revealed wordmark and the footer's background wash.
 *
 * Adapted from the "hover footer" pattern, with two deliberate changes:
 *
 *   Recoloured to the structural violet ramp. The original reveal gradient runs through
 *   #eab308, #ef4444 and #80eeb4 — amber, red and green. In this app those three are not
 *   decoration: they are the risk ratings, and the design system spends saturated colour on
 *   nothing else. A footer that paints its wordmark in the same palette as a HIGH risk badge
 *   teaches the eye to ignore the badge.
 *
 *   Motion is gated on the reduced-motion preference. The stroke-draw runs for four seconds on
 *   mount, which is exactly the kind of thing the app's blanket reduced-motion rule exists for.
 */
export const TextHoverEffect = ({
  text,
  duration,
  className,
}: {
  text: string;
  duration?: number;
  className?: string;
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);
  const [maskPosition, setMaskPosition] = useState({ cx: "50%", cy: "50%" });
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (svgRef.current && cursor.x !== null && cursor.y !== null) {
      const svgRect = svgRef.current.getBoundingClientRect();
      const cxPercentage = ((cursor.x - svgRect.left) / svgRect.width) * 100;
      const cyPercentage = ((cursor.y - svgRect.top) / svgRect.height) * 100;
      setMaskPosition({ cx: `${cxPercentage}%`, cy: `${cyPercentage}%` });
    }
  }, [cursor]);

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      viewBox="0 0 300 100"
      xmlns="http://www.w3.org/2000/svg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={(event) => setCursor({ x: event.clientX, y: event.clientY })}
      className={cn("select-none uppercase", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="phonyTextGradient" gradientUnits="userSpaceOnUse">
          {hovered && (
            <>
              <stop offset="0%" stopColor="#713dff" />
              <stop offset="50%" stopColor="#8562ff" />
              <stop offset="100%" stopColor="#b7a4fb" />
            </>
          )}
        </linearGradient>

        <motion.radialGradient
          id="phonyRevealMask"
          gradientUnits="userSpaceOnUse"
          r="20%"
          initial={{ cx: "50%", cy: "50%" }}
          animate={maskPosition}
          transition={{ duration: duration ?? 0, ease: "easeOut" }}
        >
          <stop offset="0%" stopColor="white" />
          <stop offset="100%" stopColor="black" />
        </motion.radialGradient>

        <mask id="phonyTextMask">
          <rect x="0" y="0" width="100%" height="100%" fill="url(#phonyRevealMask)" />
        </mask>
      </defs>

      {/* Resting outline, lifted slightly on hover. */}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="middle"
        strokeWidth="0.3"
        className="fill-transparent text-7xl font-bold"
        stroke="rgba(255, 255, 255, 0.1)"
        style={{ opacity: hovered ? 0.7 : 0 }}
      >
        {text}
      </text>

      {/* The drawn-in stroke. */}
      <motion.text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="middle"
        strokeWidth="0.3"
        className="fill-transparent text-7xl font-bold"
        stroke="rgba(186, 179, 255, 0.18)"
        initial={reduceMotion ? undefined : { strokeDashoffset: 1000, strokeDasharray: 1000 }}
        animate={reduceMotion ? undefined : { strokeDashoffset: 0, strokeDasharray: 1000 }}
        transition={{ duration: 4, ease: "easeInOut" }}
      >
        {text}
      </motion.text>

      {/* Revealed under the cursor. */}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="middle"
        stroke="url(#phonyTextGradient)"
        strokeWidth="0.3"
        mask="url(#phonyTextMask)"
        className="fill-transparent text-7xl font-bold"
      >
        {text}
      </text>
    </svg>
  );
};

/**
 * The footer's light source, matching the page's own: violet, entering from above, over the
 * near-black base rather than replacing it.
 */
export const FooterBackgroundGradient = () => (
  <div
    className="absolute inset-0 z-0"
    aria-hidden="true"
    style={{
      background:
        "radial-gradient(125% 125% at 50% 10%, rgba(10, 1, 24, 0.4) 50%, rgba(113, 61, 255, 0.16) 100%)",
    }}
  />
);
