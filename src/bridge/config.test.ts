import { describe, expect, it } from "vitest";

import { assertAllowedCwd } from "./config.js";

describe("assertAllowedCwd", () => {
  it("accepts a root and its descendants", () => {
    expect(assertAllowedCwd("/work/project/src", ["/work/project"])).toBe("/work/project/src");
  });

  it("rejects sibling paths with the same prefix", () => {
    expect(() => assertAllowedCwd("/work/project-secret", ["/work/project"])).toThrow(/outside/);
  });
});
