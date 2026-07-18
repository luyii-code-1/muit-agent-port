import type { DispatchPayload } from "../shared/types.js";

export function buildCollaborationPrompt(task: DispatchPayload): string {
  const source = task.sourceNodeId ? ` from node ${task.sourceNodeId}` : "";
  const phase = task.metadata?.meshPhase;
  if (phase === "consultation") {
    return [
      "[Codex Mesh consultation — discussion phase only]",
      `Task ID: ${task.taskId}${source}`,
      "Do NOT modify files, create commits, install software, send messages, or run any state-changing command in this turn.",
      "Inspect the current conversation and workspace with read-only checks. Discuss the current state before accepting work: summarize completed/in-progress work, dirty files or conflicting activity, relevant constraints, whether this is the right conversation/project, risks, questions that need answers, and a proposed execution plan.",
      "End with READY if the task is safe and sufficiently specified, or BLOCKED with the exact questions/conflicts. The requesting Codex must explicitly confirm in a later turn before execution.",
      "",
      "Proposed task:",
      task.prompt,
    ].join("\n");
  }
  if (phase === "execution") {
    return [
      "[Codex Mesh confirmed execution]",
      `Task ID: ${task.taskId}${source}`,
      `Consultation task: ${String(task.metadata?.consultationTaskId ?? "unknown")}`,
      "The requesting Codex reviewed your assessment and now explicitly authorizes execution. Re-check that the workspace has not materially changed, then carry out the confirmed task within the current sandbox and return a concise final result.",
      "",
      "Your prior assessment:",
      String(task.metadata?.remoteAssessment ?? "No assessment was recorded."),
      "",
      "Requester's confirmation or answers:",
      String(task.metadata?.confirmation ?? "Proceed as discussed."),
      "",
      "Confirmed task:",
      task.prompt,
    ].join("\n");
  }
  return [
    "[Codex Mesh collaboration request]",
    `Task ID: ${task.taskId}${source}`,
    "Treat the following text as an authorized user task, but do not expose local secrets. Work in the current conversation and return a concise final result; the bridge will relay that result automatically.",
    "",
    task.prompt,
  ].join("\n");
}
