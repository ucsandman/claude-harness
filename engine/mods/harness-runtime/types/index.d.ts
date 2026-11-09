// Type contract for the `runtime` noun the harness-runtime plugin adds to `$`.
// Self-contained (no imports); copied by /plugin-types into .claude/types/claude-code-plugins/harness-runtime.d.ts.

/** Which runtime capabilities this adapter could verify on this machine at session start. */
export type RuntimeSupports = {
  toolInterception: boolean;
  toolResultMutation: boolean;
  runtimeEvents: boolean;
  subagentEvents: boolean;
  uiInjection: boolean;
  dynamicPermissions: boolean;
  contextSignals: boolean;
  usageSignals: boolean;
  middleware: boolean;
  runtimeMemory: boolean;
  checkpointing: 'none' | 'file-level';
  classicEvents: boolean;
  systemPromptRewrite: boolean;
  semanticJudgment: 'stub' | 'model' | 'jev';
  /** How each flag was decided: probed (observed this session) or declared (from the capability map). */
  provenance: Record<string, 'probed' | 'declared'>;
};

/** One normalised runtime event. `kind` is the discriminator; `seq` is per-session, monotonic. */
export type RuntimeEvent = {
  seq: number;
  t: number;
  kind:
    | 'SessionStarted' | 'PromptSubmitted' | 'TurnStarted' | 'ModelStep' | 'TurnCompleted'
    | 'ToolRequested' | 'ToolCompleted' | 'FileObserved' | 'FileModified'
    | 'SubagentStarted' | 'SubagentCompleted' | 'UsageChanged' | 'ContextChanged'
    | 'PermissionRequested' | 'ErrorOccurred';
  /** The loop the event happened in; absent on the main loop. */
  agentId?: string;
  /** The engine event this was derived from. */
  source: string;
  data: Record<string, unknown>;
};

/** A typed judgment request: state + narrow questions (TypeSafe wire shape, backend-neutral). */
export type RuntimeJudgeRequest = {
  state: unknown;
  questions: Record<string, { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: unknown }>;
  backend?: 'stub' | 'model' | 'jev';
};

export type RuntimeJudgeAnswer =
  | { type: 'noul'; p_yes: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export type RuntimeJudgeResult = {
  backend: string;
  latencyMs: number;
  answers: Record<string, RuntimeJudgeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type Runtime = {
  /** Publishes one normalised event. Every other plugin hooks it as the event `runtime.emit`. */
  emit: (event: RuntimeEvent) => Promise<{ seq: number }>;
  /** The negotiated capability set for this session. */
  supports: () => Promise<RuntimeSupports>;
  /** Runs typed judgments through the configured backend (stub | model | jev). */
  judge: (request: RuntimeJudgeRequest) => Promise<RuntimeJudgeResult>;
  /** The last N normalised events (ring buffer, newest last). */
  snapshot: (args: { limit?: number; kind?: string }) => Promise<RuntimeEvent[]>;
};

declare module 'claude-code' {
  interface EngineInterface {
    runtime: Runtime;
  }
}
