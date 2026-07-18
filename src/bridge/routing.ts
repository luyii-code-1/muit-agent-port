import type { ThreadSummary } from "../shared/types.js";

export interface RouteHints {
  cwd?: string;
  query?: string;
}

export function selectBestThread(threads: ThreadSummary[], hints: RouteHints): ThreadSummary | undefined {
  const queryTokens = tokenize(hints.query ?? "");
  const nowSeconds = Date.now() / 1000;
  const ranked = threads
    .map((thread) => {
      let score = 0;
      const haystack = `${thread.name ?? ""} ${thread.preview}`.toLowerCase();
      const cwdMatches = hints.cwd ? thread.cwd === hints.cwd : false;
      const tokenMatches = queryTokens.filter((token) => haystack.includes(token)).length;
      if (cwdMatches) score += 100;
      if (queryTokens.length > 0) score += (tokenMatches / queryTokens.length) * 80;
      if (thread.status === "idle" || thread.status === "notLoaded") score += 20;
      const ageDays = Math.max(0, nowSeconds - thread.updatedAt) / 86_400;
      score += Math.max(0, 10 - ageDays);
      return { thread, score, cwdMatches, tokenMatches };
    })
    .filter((candidate) => {
      if (hints.cwd && !candidate.cwdMatches) return false;
      if (queryTokens.length > 0 && candidate.tokenMatches === 0) return false;
      return candidate.thread.status !== "systemError";
    })
    .sort((a, b) => b.score - a.score || b.thread.updatedAt - a.thread.updatedAt);
  return ranked[0]?.thread;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2))];
}
