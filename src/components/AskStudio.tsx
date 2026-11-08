"use client";

import type { AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgAiEvent, AgReportState, AgStudioProperties } from "ag-studio";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import type { CaseRecord } from "@/lib/types";
import { useCases } from "./CasesProvider";
import { DECISION_LABEL, REASON_LABEL, statusLabel } from "./format";
import { DEFAULT_REPORT } from "./askStudioReport";

// One row per dispute: the table AG Studio's data engine and its agents work on.
export type DisputeRow = {
  dispute_id: string;
  buyer: string;
  item: string;
  claim: string;
  amount: number;
  opened: Date;
  closed: Date | null;
  status: string;
  ai_decision: string;
  ai_win_chance: number | null;
  answered_by: string;
  result: string;
  kept: number;
  refunded: number;
  simulated_history: string;
};

export function disputeRows(cases: CaseRecord[]): DisputeRow[] {
  return cases.map((c) => {
    const t = c.dispute.disputed_transactions[0];
    const d = c.submitted?.decision ?? c.recommendation?.decision;
    return {
      dispute_id: c.id,
      buyer: t?.buyer?.name ?? "Unknown",
      item: t?.items?.[0]?.item_description ?? "",
      claim: REASON_LABEL[c.dispute.reason] ?? c.dispute.reason,
      amount: Number(c.dispute.dispute_amount.value),
      opened: new Date(c.dispute.create_time),
      closed: c.outcome ? new Date(c.outcome.at) : null,
      status: c.outcome ? "Closed" : statusLabel(c),
      ai_decision: d ? DECISION_LABEL[d] : "Not investigated",
      ai_win_chance: c.recommendation ? Math.round(c.recommendation.win_probability * 100) : null,
      answered_by: c.submitted ? (c.submitted.by === "autopilot" ? "Autopilot" : "Seller") : "Not answered",
      result: c.outcome ? { WON: "Won", SETTLED: "Settled", REFUNDED: "Refunded", LOST: "Lost" }[c.outcome.result] ?? c.outcome.result : "Open",
      kept: c.outcome?.amount_kept ?? 0,
      refunded: c.outcome?.amount_lost ?? 0,
      simulated_history: c.history ? "Yes" : "No",
    };
  });
}

// AG Studio's agents run in the browser and call this adapter once per model turn. The
// turn goes to our server, which asks Gemini (src/lib/model/studio-turn.ts), and the
// answer comes back as the message and tool-call events Studio's agent loop expects.
export const geminiAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options) {
    const done = fetch("/api/studio/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: request.input,
        instructions: request.instructions,
        tools: request.tools,
        toolChoice: request.toolChoice,
        responseFormat: request.responseFormat,
      }),
      signal: options?.signal,
    }).then(async (r) => {
      const json = await r.json().catch(() => ({ error: "The AI analyst didn't answer." }));
      const response: AgLlmResponse = r.ok
        ? { id: `turn_${Date.now()}`, createdAt: Date.now(), status: "completed", output: json.output, usage: json.usage, model: json.model }
        : { id: `turn_${Date.now()}`, createdAt: Date.now(), status: "failed", output: [], error: { code: String(r.status), message: json.error ?? "The AI analyst didn't answer." } };
      return response;
    });
    async function* stream(): AsyncGenerator<AgAiEvent> {
      const res = await done;
      for (const item of res.output) {
        if (item.type === "message") {
          const text = item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
          yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
          yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text };
          yield { type: "TEXT_MESSAGE_END", messageId: item.id };
        } else if (item.type === "function_call") {
          yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name };
          yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
          yield { type: "TOOL_CALL_END", toolCallId: item.callId };
        }
      }
    }
    return { stream: stream(), complete: done };
  },
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const text = (id: keyof DisputeRow, name: string, description: string) => ({ id, name, description, format: "textFormat" as const });
const usd = (id: keyof DisputeRow, name: string, description: string) => ({ id, name, description, format: "currencyFormat" as const, formatOptions: { format: USD } });
const day = (id: keyof DisputeRow, name: string, description: string) => ({ id, name, description, format: "dateFormat" as const, formatOptions: { format: DAY } });
const FIELDS = [
  text("dispute_id", "Dispute ID", "PayPal dispute id"),
  text("buyer", "Buyer", "Buyer's name"),
  text("item", "Item", "What the buyer bought"),
  text("claim", "Claim", "The buyer's reason for the dispute, e.g. Not received, Not as described, Unauthorized"),
  usd("amount", "Amount", "Money the buyer disputed, USD"),
  day("opened", "Opened", "Date the buyer opened the dispute"),
  day("closed", "Closed", "Date PayPal closed the dispute; blank while open"),
  text("status", "Status", "Where the dispute is now"),
  text("ai_decision", "AI decision", "What Rebuttal's AI agent recommended: Fight, Partial refund or Refund"),
  { id: "ai_win_chance", name: "AI win chance %", description: "The AI agent's estimated chance, 0 to 100, of winning if the seller fights", format: "integerFormat" as const },
  text("answered_by", "Answered by", "Who sent the response to PayPal: Autopilot, Seller, or Not answered"),
  text("result", "Result", "How PayPal closed it: Won, Settled, Refunded, Lost, or Open"),
  usd("kept", "Kept", "Money the seller kept, USD"),
  usd("refunded", "Refunded", "Money given back to the buyer, USD"),
  text("simulated_history", "Simulated history", "Yes for the demo shop's 50 simulated past disputes"),
];

// Each suggested question adds to the starter dashboard (which already has KPIs for
// amount, kept and refunded) instead of repeating or replacing it.
const PROMPTS = [
  { label: "Where am I losing money?", prompt: "Which claim types cost me the most in refunds? Add a horizontal bar chart of money refunded by claim type, highest first. Keep the existing widgets." },
  { label: "Autopilot vs me", prompt: "Compare disputes answered by autopilot with ones I answered myself: number of disputes, money kept and money refunded. Add one table below the existing widgets and keep them." },
  { label: "Does fighting pay?", prompt: "For each AI decision (fight, partial refund, refund), how much money did I keep vs refund? Add a stacked bar chart below the existing widgets and keep them." },
  { label: "Monthly trend", prompt: "Show money kept and refunded by the month the dispute closed, as a line chart below the existing widgets. Keep the existing widgets." },
];

type Loaded = { Studio: ComponentType<AgStudioProperties & { modules?: unknown[]; style?: React.CSSProperties }>; modules: unknown[]; theme: AgStudioProperties["theme"]; createAiHarness: typeof import("ag-studio").createAiHarness };

// AG Studio is a large bundle, so it loads only on this page, after the data is in.
let loading: Promise<Loaded> | null = null;
function loadStudio(): Promise<Loaded> {
  loading ??= Promise.all([import("ag-studio"), import("ag-studio-react"), fetch("/api/grid-config", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))]).then(([core, react, cfg]) => {
    if (cfg.studioKey) core.AgStudioLicenseManager.setLicenseKey(cfg.studioKey);
    const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const theme = core.studioTheme.withParams({
      accentColor: css("--accent", "#0f5c4d"),
      backgroundColor: css("--panel", "#ffffff"),
      foregroundColor: css("--ink", "#1a1a1a"),
      borderColor: css("--line", "#e5e2da"),
      studioCanvasBackgroundColor: css("--bg", "#f6f4ef"),
      fontFamily: "inherit",
      // Charts in the app's colors: the first series (usually kept) green, the second
      // (usually refunded) red, then amber and grey.
      chartPaletteFills1Color: css("--fight", "#0f5c4d"),
      chartPaletteFills2Color: css("--refund", "#8a3b2e"),
      chartPaletteFills3Color: css("--offer", "#b7791f"),
      chartPaletteFills4Color: css("--muted", "#6b6b6b"),
      chartPaletteStrokes1Color: css("--fight", "#0f5c4d"),
      chartPaletteStrokes2Color: css("--refund", "#8a3b2e"),
      chartPaletteStrokes3Color: css("--offer", "#b7791f"),
      chartPaletteStrokes4Color: css("--muted", "#6b6b6b"),
    } as never);
    return { Studio: react.AgStudio as unknown as Loaded["Studio"], modules: [core.AgStudioAiModule], theme, createAiHarness: core.createAiHarness };
  });
  return loading;
}

// "Ask your disputes": an AG Studio dashboard over every dispute, where Gemini drives AG
// Studio's agent framework (lead, planning, data, page and widget agents) to build and
// change charts, KPIs and grids from a plain-English question.
export default function AskStudio() {
  const { data } = useCases();
  const [lib, setLib] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadStudio().then(setLib, (e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);
  // The data snapshot is taken once per mode, so polling doesn't reset the dashboard.
  const mode = data?.mode;
  const rows = useMemo(() => (data ? disputeRows(data.cases) : null), [mode, Boolean(data)]); // eslint-disable-line react-hooks/exhaustive-deps

  const studioData = useMemo(
    () =>
      rows && {
        description: "PayPal disputes handled by Rebuttal for one small online shop. Money is in US dollars.",
        sources: [
          {
            id: "disputes",
            name: "Disputes",
            description:
              "One row per PayPal dispute. claim = the buyer's reason; amount = money disputed; ai_decision = what Rebuttal's AI agent recommended; ai_win_chance = its estimated chance (0-100) of winning a fight; answered_by = who sent the response to PayPal; result = how PayPal closed it; kept = money the seller kept; refunded = money given back. Open disputes have result Open and no closed date.",
            primaryKeyField: "dispute_id",
            data: rows,
            fields: FIELDS,
          },
        ],
      },
    [rows],
  );

  const ai = useMemo<AgStudioProperties["ai"]>(
    () => (lib ? (params) => lib.createAiHarness(params.api as Parameters<Loaded["createAiHarness"]>[0], { adapter: geminiAdapter, primary: "lead", promptStarters: PROMPTS }) : undefined),
    [lib],
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ask your disputes</h1>
        <p className="text-sm text-muted">
          Ask a question in plain English and the AI analyst builds the answer as a live dashboard: charts, KPIs and grids that cross-filter each other. Built with AG Studio, the AG Grid dashboard
          component, whose agent framework is driven here by Gemini. Edit any widget by hand, or ask for a change. The four suggested questions replay a saved real Gemini run, so they finish in seconds; anything else you ask runs live and takes a few minutes on the free Gemini tier.
        </p>
      </div>
      {/* Wider than the app's column: the canvas needs the room next to the AI and Compose panels. */}
      <p className="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted sm:hidden">The dashboard is built for a wider screen. On a phone, swipe sideways inside it, or open this page on a laptop.</p>
      <div className="relative left-1/2 w-[calc(100vw-1.5rem)] max-w-[1800px] -translate-x-1/2 overflow-x-auto overflow-y-hidden rounded-xl border border-line bg-panel sm:w-[calc(100vw-3rem)] sm:overflow-hidden">
        {failed ? (
          <p className="p-4 text-sm text-danger">The dashboard couldn&apos;t load: {failed}</p>
        ) : !lib || !studioData ? (
          <p className="p-4 text-sm text-muted">Loading the dashboard…</p>
        ) : (
          // Phones get the full desktop layout to scroll across, instead of a squashed one.
          <div className="min-w-[1000px] sm:min-w-0" style={{ height: "78vh", minHeight: 560 }}>
            <lib.Studio
              key={mode}
              modules={lib.modules}
              theme={lib.theme}
              data={studioData as AgStudioProperties["data"]}
              initialState={DEFAULT_REPORT as unknown as AgReportState}
              mode="edit"
              panels={{ edit: { left: ["ai"], right: ["edit"] }, view: { right: ["filters"] } }}
              ai={ai}
              onApiReady={(e) => {
                // Handy for saving a dashboard from the browser console: copy(JSON.stringify(window.rebuttalStudio.getState()))
                (window as unknown as { rebuttalStudio: unknown }).rebuttalStudio = e.api;
              }}
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
