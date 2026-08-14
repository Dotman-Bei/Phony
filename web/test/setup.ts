import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom has no layout engine, which matters for two things this app uses.
 *
 * Recharts sizes itself from a ResizeObserver and refuses to draw into a zero-sized box, so
 * without both shims below every chart test would assert against an empty container and pass
 * for the wrong reason.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);

// Give every element a non-zero box so ResponsiveContainer commits to a size.
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 400 });

HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { width: 800, height: 400, top: 0, left: 0, bottom: 400, right: 800, x: 0, y: 0, toJSON: () => {} } as DOMRect;
};

// RainbowKit reads matchMedia during render.
globalThis.matchMedia =
  globalThis.matchMedia ??
  ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as never);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
