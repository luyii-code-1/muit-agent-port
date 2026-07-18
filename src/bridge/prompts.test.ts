import { describe, expect, it } from "vitest";

import { buildCollaborationPrompt } from "./prompts.js";

describe("buildCollaborationPrompt", () => {
  it("forbids changes during consultation", () => {
    const prompt = buildCollaborationPrompt({
      taskId: "consult-1",
      prompt: "Implement the API",
      routing: "best",
      metadata: { meshPhase: "consultation" },
    });
    expect(prompt).toContain("Do NOT modify files");
    expect(prompt).toContain("READY");
    expect(prompt).toContain("BLOCKED");
  });

  it("includes the prior assessment and explicit confirmation for execution", () => {
    const prompt = buildCollaborationPrompt({
      taskId: "execute-1",
      prompt: "Implement the API",
      routing: "exact",
      threadId: "thread-1",
      metadata: {
        meshPhase: "execution",
        consultationTaskId: "consult-1",
        remoteAssessment: "READY: clean workspace",
        confirmation: "Proceed with option B",
      },
    });
    expect(prompt).toContain("confirmed execution");
    expect(prompt).toContain("READY: clean workspace");
    expect(prompt).toContain("Proceed with option B");
  });
});
