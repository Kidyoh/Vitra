import type { DeclarativeNode, ISceneStore, SceneSnapshot } from '@vitra/core';
import type { TokenRegistry, TokenTree } from '@vitra/tokens';
import type { AuditResult } from '@vitra/eval';

/**
 * Category a benchmark task exercises. Used for grouping in reports.
 */
export type BenchTaskCategory = 'compose' | 'responsive' | 'tokens';

/**
 * Initial state an agent starts from. The harness builds a fresh in-memory
 * scene from this fixture for every run so tasks never share state.
 */
export interface BenchFixture {
  /** Declarative trees inserted under the document root, in order. */
  nodes: DeclarativeNode[];
  /** W3C design tokens registered before the agent starts. */
  tokens?: TokenTree;
}

/**
 * Outcome of a single task-specific functional check.
 */
export interface CheckOutcome {
  passed: boolean;
  /** Human-readable explanation of why the check passed or failed. */
  detail: string;
  /**
   * Partial credit in [0, 1]. Defaults to 1 when passed and 0 otherwise.
   * Useful for checks that measure coverage, such as token migration.
   */
  credit?: number;
}

/**
 * Role of a check in scoring.
 * - `goal`: measures whether the requested change was made.
 * - `guard`: measures that nothing else was broken. Guards cannot earn credit
 *   on their own, so an agent that does nothing does not score on them.
 */
export type BenchCheckKind = 'goal' | 'guard';

/**
 * Read-only view of the final scene handed to task checks.
 */
export interface CheckContext {
  store: ISceneStore;
  tokenRegistry: TokenRegistry;
  /** Scene snapshot captured before the agent made any tool call. */
  initialSnapshot: SceneSnapshot;
}

/**
 * Deterministic functional assertion over the final scene.
 */
export interface BenchCheck {
  id: string;
  description: string;
  /** Scoring role (default `goal`). */
  kind?: BenchCheckKind;
  /** Relative weight inside the task's functional score (default 1). */
  weight?: number;
  run(ctx: CheckContext): CheckOutcome | Promise<CheckOutcome>;
}

/**
 * A single benchmark task: a natural-language instruction, a starting scene,
 * a reference solution used for visual comparison, and functional checks.
 */
export interface BenchTask {
  id: string;
  title: string;
  category: BenchTaskCategory;
  /** Instruction given verbatim to the agent. */
  prompt: string;
  fixture: BenchFixture;
  /**
   * Node the agent is expected to produce or modify. It is rendered and
   * audited at the end of the run and compared against the reference render.
   */
  targetNodeId: string;
  /**
   * Reference solution: the full scene (fixture plus expected result) as
   * declarative trees under the root. Rendered at `targetNodeId` to produce
   * the visual ground truth.
   */
  reference: BenchFixture;
  checks: BenchCheck[];
  /**
   * Number of tool calls a competent agent needs, including one verification
   * call. Runs at or under budget receive full call-count efficiency credit.
   */
  callBudget: number;
}

/**
 * Minimal description of an MCP tool exposed to agents.
 */
export interface BenchToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Content block returned from an MCP tool call.
 */
export type BenchToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Result of a recorded tool call as seen by the agent.
 */
export interface BenchToolResult {
  isError: boolean;
  content: BenchToolContent[];
}

/**
 * Handle given to an agent for the duration of one task run. All tool calls
 * must go through `callTool` so the harness can record them.
 */
export interface BenchSession {
  task: BenchTask;
  /** Tools advertised by the Vitra MCP server. */
  tools: BenchToolDefinition[];
  /**
   * Compact JSON description of the starting scene and registered tokens.
   * The MCP surface has no scene-read tool, so agents receive this as context.
   */
  sceneContext: string;
  callTool(name: string, args: Record<string, unknown>): Promise<BenchToolResult>;
}

/**
 * An agent under evaluation. Implementations drive the session through
 * `callTool` and resolve once they consider the task complete.
 */
export interface BenchAgent {
  /** Stable identifier written into reports (e.g. "oracle", "anthropic:<model>"). */
  readonly name: string;
  run(session: BenchSession): Promise<void>;
  /**
   * Optional: returns model token usage accumulated since the previous call
   * and resets the counter. Called once after each task.
   */
  consumeUsage?(): TokenUsage;
}

/**
 * Model token usage for one task run.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * One tool invocation captured by the recorder.
 */
export interface ToolCallRecord {
  index: number;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
  /** Whether the call changed the scene graph or token registry. */
  mutated: boolean;
  /** Property-level edits the call produced, as "nodeId.prop" keys. */
  edits: string[];
  /** Reason the call counted as wasted, if it did. */
  wasted?: 'error' | 'no-op' | 'superseded';
}

/**
 * Tool-call efficiency metrics for one run.
 */
export interface EfficiencyMetrics {
  totalCalls: number;
  mutatingCalls: number;
  readOnlyCalls: number;
  failedCalls: number;
  noOpCalls: number;
  /** Mutating calls whose every edit was overwritten, reverted, or deleted later. */
  supersededCalls: number;
  wastedCalls: number;
  callBudget: number;
  callsByTool: Record<string, number>;
  /** 0-100 efficiency score. */
  score: number;
}

/**
 * Visual comparison between the agent's render and the reference render.
 */
export interface VisualMetrics {
  /** Mean structural similarity in [0, 1]; 0 when rendering failed. */
  ssim: number;
  /** Ratio of the smaller to the larger render area in [0, 1]. */
  sizeRatio: number;
  candidateSize: { width: number; height: number } | null;
  referenceSize: { width: number; height: number };
  /** 0-100 visual score. */
  score: number;
  error?: string;
}

/**
 * Full scored result for one task.
 */
export interface TaskResult {
  taskId: string;
  title: string;
  category: BenchTaskCategory;
  agent: string;
  checks: Array<{ id: string; description: string; kind: BenchCheckKind; weight: number } & CheckOutcome>;
  /** Weighted goal-check credit in [0, 1]. Scales the quality sub-scores. */
  goalCompletion: number;
  /** Goal completion multiplied by guard-check credit, as 0-100. */
  functionalScore: number;
  audit: AuditResult | null;
  /** Audit score (0-100); 0 when the target node is missing. */
  auditScore: number;
  visual: VisualMetrics;
  efficiency: EfficiencyMetrics;
  calls: ToolCallRecord[];
  /**
   * Composite score (0-100):
   * `functional * w.functional + goalCompletion * (audit * w.audit + visual * w.visual + efficiency * w.efficiency)`.
   * Quality sub-scores are gated by goal completion so an untouched or empty
   * scene cannot collect audit, visual, or efficiency credit.
   */
  score: number;
  durationMs: number;
  /** Model token usage, when the agent reports it. */
  usage?: TokenUsage;
  /** Error raised by the agent itself, if any. The run is still scored. */
  agentError?: string;
}

/**
 * Aggregate result for a suite run.
 */
export interface SuiteResult {
  agent: string;
  startedAt: string;
  tasks: TaskResult[];
  /** Mean composite score across tasks. */
  score: number;
}

/**
 * Relative weights of the sub-scores in the composite task score.
 */
export interface ScoreWeights {
  functional: number;
  audit: number;
  visual: number;
  efficiency: number;
}
