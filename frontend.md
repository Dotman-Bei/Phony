# Frontend Style Guide — "Kyvrane" system

Extracted from [`mystiquemide/kyvrane`](https://github.com/mystiquemide/kyvrane) (MIT, © 2026 MystiqueMide) · live at [kyvrane.vercel.app](https://kyvrane.vercel.app/).

**The one-line description:** violet-black horizon light system. A near-black violet page lit by a *single* light source below the fold, alpha-white surfaces instead of solid greys, gradient-clipped headlines, a perspective grid converging on the bloom, and hairline-bordered data grids. Saturated color is reserved exclusively for verdicts, so a verdict can never be mistaken for decoration.

Two things about this repo's provenance are worth knowing up front, because they change how you should read the spec:

1. **The repo documents its own system.** `DESIGN_SYSTEM.md` is a real, accurate spec — not aspirational. This document verifies it against `src/app/globals.css` and fills in what the doc leaves out (the actual gradient stacks, the responsive collapse, the component internals).
2. **The design is itself a documented derivation.** `docs/TEARDOWN_WOPE.md` is a forensic teardown of wope.com taken from computed styles, retuned for a product that authorizes capital. So this is a *second-generation* clone — worth knowing if you're about to make it third-generation. The distinguishing addition over the source is the verdict-color layer, which wope has none of.

---

## 1. Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 App Router, React 19, TypeScript |
| Styling | **One hand-written CSS file** (`src/app/globals.css`, ~1400 lines) with `@import "tailwindcss"` at the top |
| Fonts | `next/font/google` → Geist Sans + Geist Mono as CSS variables |
| Icons | `lucide-react` |
| Motion | Effectively none. One spinner keyframe, 0.15s color/background transitions |

**Architectural note:** Tailwind is imported but barely used — the entire design lives in semantic CSS classes (`.hero-grid`, `.verdict-banner`, `.panel`, `.lit-edge`). Tailwind is present as a reset. Clone this: the visual effects here (conic-gradient masks, layered radial glows, SVG data-URI grids) are genuinely awkward as utility classes.

### Font setup

```tsx
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

<html className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
  <body className="min-h-full flex flex-col">
```

---

## 2. Color tokens

```css
:root {
  /* base — violet-biased near-black, four depths */
  --bg:           #0a0118;   /* page */
  --surface:      #140b25;   /* raised panels, chrome */
  --surface-deep: #100720;   /* card interiors */
  --surface-sunk: #0d051b;   /* inputs, code, recessed wells */

  /* structure — never a verdict */
  --structure:      #713dff;
  --structure-soft: #8562ff;   /* glow gradient stops */
  --structure-pale: #b7a4fb;   /* eyebrows, icons, edge lighting */

  /* text — four steps */
  --text:           #ffffff;
  --text-secondary: #d2d0dd;
  --muted:          #9b96b0;
  --faint:          #777188;

  /* lines */
  --line:      rgba(255,255,255,0.10);
  --line-soft: rgba(255,255,255,0.06);
  --line-lit:  rgba(186,179,255,0.18);   /* violet-tinted, for lit card edges */

  /* alpha surfaces — the actual surface system */
  --fill-1: rgba(255,255,255,0.02);
  --fill-2: rgba(255,255,255,0.04);
  --fill-3: rgba(255,255,255,0.08);

  /* verdicts — the only saturated hues */
  --green:  #50c878;   /* APPROVE */
  --accent: #f2b84b;   /* REVIEW  */
  --red:    #ee6259;   /* BLOCK   */

  /* rhythm */
  --section: 124px;
  --shell:   1248px;
  --wide:    1128px;
  --content: 984px;
  --prose:   624px;
}
```

### The three rules that make this system work

**1. Surfaces are alpha over the base, never solid grey fills.** `--fill-1/2/3` are white at 2%/4%/8%. This is why panels read as frosted glass sitting on a light source rather than as flat cards. The four named `--surface-*` values exist for the opaque cases (card interiors, sunk wells); everything that should feel lit uses the alpha fills.

**2. One light source.** Glows emanate from the horizon — below the content — never from arbitrary elements. There is exactly one bloom on the landing page and one bookending it in the closing CTA. If you add a second light, the metaphor collapses.

**3. Saturated color = verdict, always.** `--structure` violet is structural and must never encode a verdict. The three verdict hues are the *only* saturated colors permitted inside the workspace. The reasoning: a `BLOCK` must scream, not blend. Since nothing else is saturated, it does.

That third rule is the interesting inversion. Most dark-UI systems make the brand color loud and status colors quiet. This one does the reverse — the brand violet is ambient and atmospheric, and status is the only thing that gets to be vivid.

---

## 3. Typography

One family (Geist Sans), with Geist Mono reserved for **data and metadata only** — never prose.

| Role | Size / line | Weight | Tracking |
|---|---|---|---|
| Hero | 72 / 80 | 700 | -0.02em |
| Section | 56 / 64 | 700 | -0.04em |
| Card title | 32 / 40 | 700 | -0.035em |
| FAQ | 24 / 32 | 700 | 0 |
| Lead | 20 / 28 | 400 | -0.2px |
| Body | 16 / 24 | 400 | -0.16px |
| UI | 14 / 24 | 500 | -0.14px |
| Eyebrow | 10px mono | 600 | +0.15em, uppercase |

**Negative tracking scales with size; eyebrows invert it.** Display type tightens (-0.02 to -0.04em), small mono labels open up (+0.15em). Same crossover principle as any well-built scale, executed cleanly here.

Responsive sizes use `clamp()`: hero is `clamp(40px, 6vw, 72px)`, sections `clamp(28px, 4.4vw, 56px)`.

### Gradient-clipped headlines — the signature

Every marketing headline is clipped white-to-translucent, never a flat color:

```css
.lit-heading {
  background: linear-gradient(#ffffff 22.5%, rgba(255,255,255,0.7) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

The `22.5%` stop is what makes it read as *lit from above* rather than as a generic gradient — the top fifth stays pure white, then it falls off. Applied to `h1`, section `h2`s, FAQ summaries, and the closing CTA.

**The workspace uses flat white instead.** Marketing gets gradient headlines; the product surface doesn't. That split is deliberate — inside a tool that authorizes capital, atmosphere gives way to legibility.

### Mono micro-labels

Everywhere metadata appears, it's mono at **7–11px** with wide positive tracking:

```css
.eyebrow, .panel-index, .section-label {
  color: var(--structure-pale);
  font: 600 10px/1 var(--font-geist-mono), ui-monospace, monospace;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
```

Sizes descend to 7px for the smallest annotations. All numeric values in data grids are mono too (`font: 600 22px var(--font-geist-mono)`) — numbers align, prose doesn't need to.

---

## 4. The light system

This is the part that makes the design, and it's three layered techniques.

### A) The bloom — three stacked radial gradients

```css
.hero-grid {
  position: absolute;
  inset: 0 0 auto;
  height: 900px;
  pointer-events: none;
  background-image:
    /* hot core */
    radial-gradient(20% 9%  at 50% 74%, rgba(233,224,255,0.85) 0%, rgba(199,183,255,0) 100%),
    /* main bloom */
    radial-gradient(34% 19% at 50% 75%, rgba(139,106,255,0.85) 0%, rgba(139,106,255,0) 100%),
    /* ambient spill */
    radial-gradient(62% 38% at 50% 76%, rgba(113,61,255,0.50) 0%, rgba(113,61,255,0)  100%);
}
```

Three ellipses at nearly the same center (74%/75%/76%), each wider and dimmer than the last, each a slightly cooler violet. That layering is what reads as a physical light rather than a flat purple smudge. Copy the structure, not just one gradient.

### B) The perspective grid — inline SVG data URI, masked

Radiating lines converge on the bloom's center; horizontal lines compress toward it. Then it's **masked so it dies before reaching the headline**:

```css
.hero-grid::before {
  background-image: url("data:image/svg+xml,...");   /* converging line grid */
  background-position: center 90px;
  mask-image: radial-gradient(56% 38% at 50% 75%, #000 0%, rgba(0,0,0,0.3) 55%, transparent 100%);
}
```

The mask is the craft. Without it the grid competes with the type; with it the grid appears to be *generated by* the light.

### C) The product surface rises out of the glow

```css
.hero-product {
  margin: 150px auto 0;
  border: 1px solid var(--line-lit);
  border-radius: 16px 16px 0 0;   /* top corners only — no bottom edge */
  background: var(--surface-deep);
  box-shadow: 0 -28px 90px rgba(113,61,255,0.24);   /* upward glow */
}
```

Radius on the top corners only and no bottom border, so the panel appears to emerge from the horizon and continue past the fold. The shadow points *up* (negative Y) — it's light spilling from below, not a drop shadow.

### D) The horizon returns at the close

`.closing-cta::before` repeats the same treatment — two radial glows plus a second SVG grid — positioned at the bottom of the card, bookending the page. Same idea, smaller scale.

### The lit edge — conic border sweep

For elements that need a top highlight:

```css
.lit-edge::before {
  content: ""; position: absolute; inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from 0deg,
    rgba(255,255,255,0.5) 0deg, rgba(255,255,255,0) 60deg,
    rgba(255,255,255,0) 310deg, rgba(255,255,255,0.5) 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
```

Bright at the top of the arc, dead on the sides — a 1px border that's only lit where light would actually hit it. The mask-composite trick renders the gradient as border-only.

---

## 5. Geometry and layout

### Containers — four widths, strictly used

```
--shell:   1248px   /* nav, footer */
--wide:    1128px   /* sections, workspace */
--content:  984px   /* FAQ */
--prose:    624px   /* body copy — never exceeded */
```

Full-bleed sections get their gutters from `padding: 0 max(24px, calc((100vw - var(--shell)) / 2))` — centers the content without a wrapper div.

### Radii — two shapes, no exceptions

```
999px  → anything interactive (buttons, pills, badges)
16px   → cards
12px   → panels
10px   → controls (inputs, switches)
 8px   → small chips, icon buttons
```

### Section rhythm

`--section: 124px`, dropping to 88px below 670px. Spacing is 4px-based, clustering on 8/12/16/20.

### Composite panel radii

Multi-panel layouts share one rounded rectangle by giving each panel partial radii and removing interior borders:

```css
.proposal-panel { border-radius: 16px 0 0 0;   border-right: 0; }
.decision-panel { border-radius: 0 16px 0 0; }
.history-panel  { border-radius: 0 0 16px 16px; border-top: 0; grid-column: 1 / -1; }
```

Three panels read as one object. On mobile these re-radius to stack vertically.

---

## 6. Components

### Pill button (ghost) — alpha fill + inner top-light

```css
.nav-action, .hero-action {
  min-height: 40px; padding: 8px 20px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background:
    radial-gradient(107.5% 107.5% at 50% 215%, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 100%),
    var(--fill-2);
  color: var(--text);
  transition: background 0.18s, border-color 0.18s;
}
:hover {
  background: radial-gradient(107.5% 107.5% at 50% 215%, rgba(255,255,255,0.30) 0%, transparent 100%), var(--fill-3);
  border-color: rgba(186,179,255,0.35);
}
```

The radial at `50% 215%` sits below the button and lights its bottom edge — consistent with the page's one-light-source rule, applied at component scale. Hover brightens the light and warms the border toward violet. **Nothing moves.**

### Primary action — the one solid light object

```css
.primary-action {
  min-height: 50px;
  border: 1px solid #f9f8fc;
  border-radius: 999px;
  background: #f9f8fc;    /* off-white, not pure */
  color: #0a0118;
  font-weight: 600; font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.08em;
}
```

Exactly one solid-white button in the product. On a page where everything else is translucent, opacity itself becomes the emphasis mechanism.

### Verdict banner — the safety-critical component

```css
.verdict-banner {
  min-height: 74px; padding: 16px;
  border: 1px solid currentColor;   /* inherits the verdict color */
  border-radius: 12px;
  display: flex; align-items: center; gap: 12px;
}
.verdict-approve { color: var(--green);  background: rgba(80,200,120,0.06); }
.verdict-review  { color: var(--accent); background: rgba(242,184,75,0.06); }
.verdict-block   { color: var(--red);    background: rgba(238,98,89,0.06); }
```

`border: 1px solid currentColor` plus a 6% tint of the same hue — one class sets the color and the border and background follow. The value itself (`strong`) stays `var(--text)` white; the *color* carries the verdict, the *text* stays legible.

### Mode badge — same weight as a verdict

```css
.mode-badge {
  padding: 6px 11px;
  border: 1px solid currentColor; border-radius: 999px;
  font: 600 9px var(--font-geist-mono); letter-spacing: 0.12em;
}
.mode-live         { color: var(--green);  background: rgba(80,200,120,0.08); }
.mode-demo         { color: var(--accent); background: rgba(242,184,75,0.08); }
.mode-unconfigured { color: var(--muted);  background: var(--fill-2); }
```

From the source's own comment: mode badges carry the same semantic weight as a verdict and must not be pretty at the cost of being clear. Demo and unconfigured never borrow the live color. This is downstream of a stated product rule — *mark provider data `live` or `demo`; never imply fallback data is live.*

### Data grid — borders, not gaps

```css
.hero-metrics, .metric-grid, .execution-summary, .scenario-inputs {
  display: grid; grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--line);
}
> div { padding: 22px; border-right: 1px solid var(--line); }
> div:last-child { border-right: 0; }
```

Cells share hairlines rather than sitting apart with gaps. Repeated for every metric row in the product. Label is mono 8px `--faint`; value is mono 600 at 15–22px.

### Panel header

70px tall, `--surface` background (lighter than the `--surface-deep` body), bottom hairline, mono index + 14px/600 title on the left, mono state indicator on the right.

### Policy card — the left-border accent

```css
.policy-card {
  border: 1px solid var(--line);
  border-left: 1px solid var(--structure);   /* violet spine */
  border-radius: 0 10px 10px 0;              /* square on the accent side */
  background: var(--fill-1);
}
```

Squaring the corner on the accented edge makes the spine read as a marker rather than a stray border.

### FAQ — CSS-drawn cross

```css
.faq-list summary span::before { width: 15px; height: 1.5px; }  /* horizontal bar */
.faq-list summary span::after  { width: 1.5px; height: 15px; }  /* vertical bar */
.faq-list details[open] summary span { transform: rotate(45deg); }
```

Native `<details>`/`<summary>`, marker hidden. The comment explains why it's drawn rather than typed: *the rotated "+" glyph renders as an asterisk in Geist.* Worth knowing if you use the same face.

### Source badge

Pill with a 5px colored dot: green for live, `--faint` for local. Same live/demo honesty rule.

---

## 7. Responsive

**Four breakpoints, no tablet-specific one:** `1248` / `980` / `670` / `390`.

- **1248** — containers switch from centered-calc to fixed 24px gutters; feature pair reweights.
- **980** — nav links vanish entirely (no hamburger; the links are simply dropped); all two-column grids collapse; the three-panel workspace restacks and re-radiuses; history grid goes 3-col → 2-col.
- **670** — the real mobile pass. Nav 78px → 68px, brand subtitle hidden, hero shortened, `.hero-policy-row` and `.hero-verdict small` **hidden outright** rather than reflowed, metric grids go 4-col → 2×2 with borders rewritten per-child, FAQ left-aligns.
- **390** — three surgical fixes only: hero `h1` to 36px, hash timestamp hidden, meta gap tightened.

The pattern worth copying: at narrow widths this design **removes** secondary information instead of shrinking it. The policy row and the proof timestamp don't get smaller — they leave.

Reduced motion is a blanket kill:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

---

## 8. Motion

Almost none, and that's a position. A product that authorizes capital shouldn't bounce.

- `0.15s` transitions on **color and background only** — nav links, icon buttons, inputs, history rows.
- `0.18s` on the pill buttons' background/border.
- `0.2s` on the FAQ cross rotation.
- One `@keyframes spin` for the loading spinner.

No transforms on hover, no scroll reveals, no entrance animation, no animation library. Depth and interest come from the light system, which is static.

---

## 9. Accessibility floor

- `:focus-visible` paired with `:hover` on every interactive selector — the two are styled together throughout, so focus is never an afterthought.
- Blanket `prefers-reduced-motion` kill switch.
- Native `<details>`/`<summary>` for the FAQ — keyboard and screen-reader behavior for free.
- **44px minimum touch targets on mobile**, applied to standalone nav links only, with a comment noting that inline prose links are deliberately left alone because padding them would break text flow. That distinction is more thought than most systems give it.
- `aria-label` on the brand lockup, `aria-label` on nav landmarks.
- Text colors are a genuine four-step ramp (`#fff` → `#d2d0dd` → `#9b96b0` → `#777188`), so hierarchy doesn't depend on size alone.

---

## 10. Copy voice

Terse, technical, forensic. The product is a verification tool and the copy behaves like one.

- **Mono uppercase system labels** everywhere: `DETERMINISTIC VERDICT`, `NO RECEIPT GENERATED`, `ALL CHECKS PASSED`, `LAST UPDATED`, `PRE-EXECUTION FIREWALL`.
- **Empty states state the absence as a fact**, positioned as a corner annotation rather than an apology — `.empty-state::before` renders `NO RECEIPT GENERATED` in the top-right corner.
- **Verdict labels are past-participle and final:** "Approved", "Review required", "Blocked".
- **Stated content rules, worth adopting wholesale:** no mascots, no placeholder analytics, no decorative crypto imagery, no emoji. Mark provider data `live` or `demo` — never imply fallback data is live.

---

## 11. Build checklist

1. `globals.css`: `@import "tailwindcss"` then the `:root` token block — four surface depths, three structure violets, four text steps, three line weights, three alpha fills, three verdict colors, five layout widths.
2. Set `html`/`body` background to `--bg` and load Geist Sans + Geist Mono as variables.
3. Build the `.lit-heading` gradient-clip primitive first — it's the cheapest premium signal in the system.
4. Build the hero light: three stacked radial gradients at ~75% height, then the SVG grid as `::before`, masked with a radial so it dies before the headline.
5. Float the product panel over it with top-only radius, `--line-lit` border, and an *upward* violet glow.
6. Surfaces use the alpha fills (`--fill-1/2/3`), not solid greys. Reserve the opaque `--surface-*` values for card interiors and sunk wells.
7. Two radii only: 999px for interactive, 16/12/10px for containers.
8. Data grids share hairlines — no gaps. Mono numerals, mono micro-labels.
9. Verdict components use `border: 1px solid currentColor` + a 6% background tint, driven by one class.
10. Four breakpoints. At 670px, delete secondary information rather than shrinking it.
11. Close with the blanket reduced-motion rule.

---

## 12. What to change when reusing

| Keep | Change |
|---|---|
| One light source, positioned below the content | The hue — any saturated color works as the bloom |
| Three-layer radial bloom (hot core / bloom / spill) | The exact stops |
| Alpha-white surfaces over the base, never solid greys | — this is the system |
| Gradient-clipped headlines at a 22.5% stop | Whether the workspace also uses them (here it doesn't, deliberately) |
| Mono reserved for data and metadata only | Geist → any sans + mono pair |
| Two-shape radius discipline | The values |
| Hairline-shared data grids | — |
| Four breakpoints; remove rather than shrink | The values |
| Near-zero motion | Only if your product's seriousness warrants it |

**The rule to think hardest about before copying:** saturated color reserved entirely for verdicts. It's the best idea here and the most context-dependent. It works because this product's whole job is producing a three-way verdict, so status genuinely deserves to be the loudest thing on screen. If your product doesn't have a comparable decision at its center, you'll have banned yourself from using color for emphasis and gained nothing — you'd end up with an all-violet page and no reason for the constraint.

Also worth registering: this design is already a derivation from wope.com (documented in `docs/TEARDOWN_WOPE.md`), and the horizon-grid-plus-violet-bloom treatment is widely used in dev-tool marketing. It's executed unusually well here, but it isn't distinctive on its own. The verdict-color layer is what the author actually added, and it's the part that would still be yours if you built on it.
