// Picks the model: AI_PROVIDER=gemini|claude, otherwise whichever key is set
// (Gemini first, because its free tier keeps the hosted demo at zero cost).

import { claudeModel } from "./claude";
import { geminiModel } from "./gemini";
import type { AgentModel } from "./types";
import { takeModelCall } from "../rate-limit";

// Every live call made through the default model counts against the shared limits.
export function defaultModel(): AgentModel {
  const m = pickModel();
  return { ...m, next: (...args: Parameters<AgentModel["next"]>) => (takeModelCall(), m.next(...args)) };
}

function pickModel(): AgentModel {
  const choice = process.env.AI_PROVIDER?.toLowerCase();
  if (choice === "claude") return claudeModel();
  if (choice === "gemini") return geminiModel();
  if (process.env.GEMINI_API_KEY) return geminiModel();
  if (process.env.APP_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) return claudeModel();
  throw new Error("No AI model configured. Set GEMINI_API_KEY (or APP_ANTHROPIC_API_KEY with AI_PROVIDER=claude).");
}

export { claudeModel, geminiModel };
export type { AgentModel };
