import { describe, expect, it } from "vitest";

import { finalAgentMessage, mergeTurnItems } from "./codexAppServer.js";

describe("finalAgentMessage", () => {
  it("returns the last persisted agent message", () => {
    expect(finalAgentMessage({
      id: "turn-1",
      status: "completed",
      items: [
        { type: "agentMessage", text: "progress" },
        { type: "reasoning", text: "summary" },
        { type: "agentMessage", text: "READY" },
      ],
    })).toBe("READY");
  });

  it("does not invent a final message for a slim completion notification", () => {
    expect(finalAgentMessage({ id: "turn-1", status: "completed", items: [] })).toBeUndefined();
  });

  it("preserves streamed items when the completion notification is slim", () => {
    const items = mergeTurnItems(
      [{ id: "message-1", type: "agentMessage", text: "READY" }],
      [],
    );
    expect(finalAgentMessage({ id: "turn-1", status: "completed", items })).toBe("READY");
  });

  it("prefers the completed version of an item with the same id", () => {
    expect(mergeTurnItems(
      [{ id: "command-1", type: "commandExecution", status: "inProgress" }],
      [{ id: "command-1", type: "commandExecution", status: "completed", output: "OK" }],
    )).toEqual([{ id: "command-1", type: "commandExecution", status: "completed", output: "OK" }]);
  });
});
