import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createDocumentNode,
  InMemorySceneStore,
  insertDeclarativeTree,
  type ISceneStore,
  type SceneNode,
} from '@vitra/core';
import { TokenRegistry } from '@vitra/tokens';
import { computeLayout } from '@vitra/layout';
import { renderToPng } from '@vitra/renderer';
import { auditDesign, type AuditResult } from '@vitra/eval';
import { createVitraServer } from '@vitra/mcp-server';
import { decodePng, type RgbaImage } from './png.js';
import { resizeRgba, ssimMetric, type ImageSimilarityMetric } from './similarity.js';
import { computeEfficiency, ToolCallRecorder } from './recorder.js';
import type {
  BenchAgent,
  BenchFixture,
  BenchSession,
  BenchTask,
  ScoreWeights,
  SuiteResult,
  TaskResult,
  VisualMetrics,
} from './types.js';

/** Identifier of the document root created for every benchmark scene. */
export const BENCH_ROOT_ID = 'root';

/**
 * Default composite weights. Functional correctness dominates; audit quality
 * and visual fidelity follow; efficiency breaks ties between correct agents.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  functional: 0.4,
  audit: 0.2,
  visual: 0.25,
  efficiency: 0.15,
};

/**
 * Options controlling a benchmark run.
 */
export interface RunOptions {
  /** Overrides for the composite score weights. They are re-normalised to sum to 1. */
  weights?: Partial<ScoreWeights>;
  /** Image similarity metric (default: SSIM). */
  visualMetric?: ImageSimilarityMetric;
  /** Render scale for visual comparison (default 1). */
  renderScale?: number;
  /** Abort the agent after this many milliseconds (default: no limit). */
  timeoutMs?: number;
}

/**
 * A freshly built scene and token registry for a fixture.
 */
export interface BenchScene {
  store: InMemorySceneStore;
  tokenRegistry: TokenRegistry;
}

/**
 * Builds an isolated scene from a fixture: a document root with each fixture
 * tree inserted in order, and the fixture tokens registered.
 */
export function buildScene(fixture: BenchFixture): BenchScene {
  const store = new InMemorySceneStore(createDocumentNode({ id: BENCH_ROOT_ID, name: 'Bench Canvas' }));
  for (const node of fixture.nodes) {
    insertDeclarativeTree(store, node, BENCH_ROOT_ID);
  }
  const tokenRegistry = new TokenRegistry();
  if (fixture.tokens) {
    tokenRegistry.registerTokens(fixture.tokens);
  }
  return { store, tokenRegistry };
}

/**
 * Serialises a scene into the compact JSON context handed to agents: nodes in
 * depth-first order with structural bookkeeping fields removed, plus tokens.
 */
export function describeScene(store: ISceneStore, fixture: BenchFixture): string {
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: SceneNode): void => {
    if (node.type !== 'document') {
      const { childIds: _c, visible: _v, locked: _l, ...rest } = node as SceneNode & {
        childIds?: string[];
      };
      nodes.push(rest);
    }
    for (const child of store.getChildren(node.id)) {
      visit(child);
    }
  };
  visit(store.getRoot());
  return JSON.stringify({ rootId: BENCH_ROOT_ID, nodes, tokens: fixture.tokens ?? {} });
}

/**
 * Renders a node to RGBA pixels through the production layout and renderer.
 */
export async function renderNode(
  store: ISceneStore,
  nodeId: string,
  tokenRegistry: TokenRegistry,
  scale = 1
): Promise<RgbaImage> {
  const layout = await computeLayout(store, nodeId);
  const png = await renderToPng({ store, targetNodeId: nodeId, layout, tokenRegistry }, { scale });
  return decodePng(png);
}

/**
 * Runs one task against one agent in an isolated scene and scores the result.
 * Agent exceptions and timeouts are captured in `agentError`; the final scene
 * is scored regardless so partial progress is still measured.
 */
export async function runTask(
  task: BenchTask,
  agent: BenchAgent,
  options: RunOptions = {}
): Promise<TaskResult> {
  const started = performance.now();
  const { store, tokenRegistry } = buildScene(task.fixture);
  const initialSnapshot = store.exportSnapshot();
  const sceneContext = describeScene(store, task.fixture);

  const server = createVitraServer(store, tokenRegistry);
  const client = new Client({ name: `vitra-bench:${agent.name}`, version: '0.1.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const recorder = new ToolCallRecorder(client, store);
  const listed = await client.listTools();
  const session: BenchSession = {
    task,
    tools: listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
    sceneContext,
    callTool: (name, args) => recorder.callTool(name, args),
  };

  let agentError: string | undefined;
  try {
    await withTimeout(agent.run(session), options.timeoutMs);
  } catch (err: unknown) {
    agentError = err instanceof Error ? err.message : String(err);
  } finally {
    recorder.close();
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  const checks: TaskResult['checks'] = [];
  for (const check of task.checks) {
    const base = { id: check.id, description: check.description, kind: check.kind ?? 'goal', weight: check.weight ?? 1 };
    try {
      const outcome = await check.run({ store, tokenRegistry, initialSnapshot });
      checks.push({ ...base, ...outcome });
    } catch (err: unknown) {
      checks.push({
        ...base,
        passed: false,
        detail: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const goalCompletion = weightedCredit(checks.filter((c) => c.kind === 'goal'));
  const guardCredit = weightedCredit(checks.filter((c) => c.kind === 'guard'), 1);
  const functionalScore = Math.round(100 * goalCompletion * guardCredit);

  let audit: AuditResult | null = null;
  if (store.getNode(task.targetNodeId)) {
    audit = await auditDesign(store, task.targetNodeId, { tokenRegistry }).catch(() => null);
  }
  const auditScore = audit ? audit.score : 0;

  const visual = await compareToReference(task, store, tokenRegistry, options);
  const calls = recorder.getRecords();
  const efficiency = computeEfficiency(calls, task.callBudget);

  const weights = normalizeWeights({ ...DEFAULT_WEIGHTS, ...options.weights });
  const score = Math.round(
    weights.functional * functionalScore +
      goalCompletion *
        (weights.audit * auditScore + weights.visual * visual.score + weights.efficiency * efficiency.score)
  );

  const result: TaskResult = {
    taskId: task.id,
    title: task.title,
    category: task.category,
    agent: agent.name,
    checks,
    goalCompletion: round4(goalCompletion),
    functionalScore,
    audit,
    auditScore,
    visual,
    efficiency,
    calls,
    score,
    durationMs: Math.round(performance.now() - started),
  };
  const usage = agent.consumeUsage?.();
  if (usage) {
    result.usage = usage;
  }
  if (agentError !== undefined) {
    result.agentError = agentError;
  }
  return result;
}

/**
 * Runs every task sequentially against one agent.
 */
export async function runSuite(
  tasks: BenchTask[],
  agent: BenchAgent,
  options: RunOptions = {}
): Promise<SuiteResult> {
  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, agent, options));
  }
  const score =
    results.length === 0 ? 0 : Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  return { agent: agent.name, startedAt, tasks: results, score };
}

async function compareToReference(
  task: BenchTask,
  store: ISceneStore,
  tokenRegistry: TokenRegistry,
  options: RunOptions
): Promise<VisualMetrics> {
  const metric = options.visualMetric ?? ssimMetric;
  const scale = options.renderScale ?? 1;
  const reference = buildScene(task.reference);
  const referenceImage = await renderNode(reference.store, task.targetNodeId, reference.tokenRegistry, scale);
  const referenceSize = { width: referenceImage.width, height: referenceImage.height };

  if (!store.getNode(task.targetNodeId)) {
    return {
      ssim: 0,
      sizeRatio: 0,
      candidateSize: null,
      referenceSize,
      score: 0,
      error: `Target node "${task.targetNodeId}" does not exist in the final scene.`,
    };
  }

  try {
    const candidate = await renderNode(store, task.targetNodeId, tokenRegistry, scale);
    const candidateArea = candidate.width * candidate.height;
    const referenceArea = referenceImage.width * referenceImage.height;
    const sizeRatio = Math.min(candidateArea, referenceArea) / Math.max(candidateArea, referenceArea);
    const resized = resizeRgba(candidate, referenceImage.width, referenceImage.height);
    const similarity = await metric.compare(resized, referenceImage);
    return {
      ssim: round4(similarity),
      sizeRatio: round4(sizeRatio),
      candidateSize: { width: candidate.width, height: candidate.height },
      referenceSize,
      score: Math.round(100 * similarity * Math.sqrt(sizeRatio)),
    };
  } catch (err: unknown) {
    return {
      ssim: 0,
      sizeRatio: 0,
      candidateSize: null,
      referenceSize,
      score: 0,
      error: `Render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function normalizeWeights(weights: ScoreWeights): ScoreWeights {
  const total = weights.functional + weights.audit + weights.visual + weights.efficiency;
  if (!(total > 0)) {
    throw new Error('Score weights must sum to a positive number.');
  }
  return {
    functional: weights.functional / total,
    audit: weights.audit / total,
    visual: weights.visual / total,
    efficiency: weights.efficiency / total,
  };
}

function weightedCredit(
  checks: Array<{ weight: number; passed: boolean; credit?: number }>,
  empty = 0
): number {
  const total = checks.reduce((sum, c) => sum + c.weight, 0);
  if (total === 0) return empty;
  const earned = checks.reduce(
    (sum, c) => sum + c.weight * Math.max(0, Math.min(1, c.credit ?? (c.passed ? 1 : 0))),
    0
  );
  return earned / total;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Agent exceeded the ${timeoutMs}ms time limit.`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
