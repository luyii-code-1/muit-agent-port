import { describe, expect, it } from "vitest";

import { parseRoleSummary } from "./bridgeHub.js";

describe("parseRoleSummary", () => {
  it("reads, trims, and deduplicates the structured role marker", () => {
    expect(parseRoleSummary('Done\nROLE_LABELS_JSON: ["Android", " BLE ", "Android"]\nREADY'))
      .toEqual(["Android", "BLE"]);
  });

  it("ignores prose and malformed role data", () => {
    expect(parseRoleSummary("Android and firmware developer")).toEqual([]);
    expect(parseRoleSummary("ROLE_LABELS_JSON: nope")).toEqual([]);
  });
});
