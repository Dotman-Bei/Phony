/**
 * The Phony mark — a folded zigzag ribbon rising to the right, capped by a long descending
 * bar at the apex.
 *
 * Drawn as a single stroked polyline with round caps and joins rather than as filled
 * outlines. That is what gives it the reference's "extruded ribbon" read, and it means the
 * whole mark is four coordinates: it stays sharp at 16px in a browser tab and at any size
 * in the nav, with no raster assets to ship.
 *
 * The reference render is copper and magenta. Recoloured here onto the structural violet
 * ramp (`--structure-pale` -> `--structure`) so the logo belongs to the same light source
 * as the rest of the page. Deliberately not a verdict hue: green, amber and red stay
 * reserved for risk ratings and data provenance, and a logo is neither.
 *
 * The gradient id is instance-scoped. SVG defs live in a global namespace, so two of these
 * on one page with a hardcoded id would have the second silently steal the first's fill.
 */
export function PhonyMark({
  size = 30,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Set only when the mark stands alone as a link's accessible name. */
  title?: string;
}) {
  const gradientId = `phony-mark-gradient`;
  const shineId = `phony-mark-shine`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradientId} x1="6" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e4dbff" />
          <stop offset="28%" stopColor="#9d80ff" />
          <stop offset="62%" stopColor="#713dff" />
          <stop offset="100%" stopColor="#c4b3ff" />
        </linearGradient>

        {/* A second, lighter pass along the top edge. The reference's depth comes from a
            bright bevel catching light on one side, not from a drop shadow. */}
        <linearGradient id={shineId} x1="14" y1="8" x2="46" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path
        d="M14 54 L34 43 L18 29 L42 10 L50 40"
        stroke={`url(#${gradientId})`}
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 54 L34 43 L18 29 L42 10 L50 40"
        stroke={`url(#${shineId})`}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(-1.6 -1.9)"
      />
    </svg>
  );
}
