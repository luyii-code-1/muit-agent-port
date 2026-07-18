import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../shared/types.js";
import { selectBestThread } from "./routing.js";

const threads: ThreadSummary[] = [
  {
    id: "frontend",
    name: "Checkout UI",
    preview: "Fix the checkout React form",
    cwd: "/work/shop",
    status: "idle",
    createdAt: 100,
    updatedAt: 900,
  },
  {
    id: "backend",
    name: "Payments API",
    preview: "Implement Stripe webhook",
    cwd: "/work/shop",
    status: "idle",
    createdAt: 100,
    updatedAt: 1_000,
  },
  {
    id: "other",
    name: "Docs",
    preview: "Update README",
    cwd: "/work/docs",
    status: "idle",
    createdAt: 100,
    updatedAt: 1_100,
  },
];

describe("selectBestThread", () => {
  it("uses cwd and semantic title hints", () => {
    vi.setSystemTime(new Date(1_500_000));
    expect(selectBestThread(threads, { cwd: "/work/shop", query: "Stripe payments" })?.id).toBe("backend");
    vi.useRealTimers();
  });

  it("uses the most recent suitable thread when no hints are supplied", () => {
    expect(selectBestThread(threads, {})?.id).toBe("other");
  });

  it("returns undefined when required hints do not match", () => {
    expect(selectBestThread(threads, { cwd: "/missing", query: "unknown" })).toBeUndefined();
  });
});
