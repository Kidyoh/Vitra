import type { BenchAgent, BenchSession, BenchToolContent, TokenUsage } from '../types.js';

/**
 * Configuration for the Anthropic Messages API agent.
 */
export interface AnthropicAgentOptions {
  /** API key (default: `ANTHROPIC_API_KEY`). */
  apiKey?: string;
  /** Model identifier (default: `VITRA_BENCH_MODEL` or `claude-sonnet-5-5`). */
  model?: string;
  /** Maximum model turns per task before the run is abandoned (default 25). */
  maxTurns?: number;
  /** `max_tokens` per model response (default 4096). */
  maxTokens?: number;
  /** API base URL (default: `https://api.anthropic.com`). */
  baseUrl?: string;
  /** Forward rendered PNGs from `render_viewport` to the model (default true). */
  includeImages?: boolean;
  /** Fetch implementation, injectable for tests (default: global fetch). */
  fetch?: typeof fetch;
}

/** Default model when neither an option nor `VITRA_BENCH_MODEL` is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

const SYSTEM_PROMPT = [
  'You are a design engineer operating the Vitra visual runtime through its MCP tools.',
  'Complete the task using tool calls only. The user message includes a JSON description of the starting scene, including node ids and registered tokens; there is no tool to read the scene, so rely on it.',
  'Prefer insert_component for building multi-node structures in a single call, verify your result once with audit_design or render_viewport, and fix any reported issues.',
  'You are scored on correctness, accessibility audit results, visual fidelity, and tool-call efficiency: avoid redundant, failing, or later-overwritten calls.',
  'When the task is complete, reply with a short summary and no further tool calls.',
].join('\n');

interface AnthropicContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Reference agent that drives the benchmark with Claude through the Anthropic
 * Messages API tool-use loop. It uses `fetch` directly so the benchmark does
 * not take an SDK dependency.
 */
export class AnthropicAgent implements BenchAgent {
  readonly name: string;
  private readonly model: string;
  private readonly options: AnthropicAgentOptions;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(options: AnthropicAgentOptions = {}) {
    this.options = options;
    this.model = options.model ?? process.env.VITRA_BENCH_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    this.name = `anthropic:${this.model}`;
  }

  consumeUsage(): TokenUsage {
    const usage = this.usage;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    return usage;
  }

  async run(session: BenchSession): Promise<void> {
    const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('AnthropicAgent requires an API key. Set ANTHROPIC_API_KEY or pass { apiKey }.');
    }
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const maxTurns = this.options.maxTurns ?? 25;
    const includeImages = this.options.includeImages ?? true;

    const tools = session.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema,
    }));
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      {
        role: 'user',
        content: `${session.task.prompt}\n\nScene context (JSON):\n${session.sceneContext}`,
      },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.options.maxTokens ?? 4096,
          system: SYSTEM_PROMPT,
          tools,
          messages,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Anthropic API request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      const data = (await response.json()) as AnthropicResponse;
      this.usage.inputTokens += data.usage?.input_tokens ?? 0;
      this.usage.outputTokens += data.usage?.output_tokens ?? 0;

      const content = data.content ?? [];
      messages.push({ role: 'assistant', content });
      const toolUses = content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
        return;
      }

      const results = [];
      for (const use of toolUses) {
        const args = use.input && typeof use.input === 'object' ? (use.input as Record<string, unknown>) : {};
        const result = await session.callTool(use.name ?? '', args);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: result.isError,
          content: toAnthropicContent(result.content, includeImages),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    throw new Error(`Agent did not finish within ${maxTurns} turns.`);
  }
}

function toAnthropicContent(content: BenchToolContent[], includeImages: boolean): unknown[] {
  const blocks: unknown[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (includeImages) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } });
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '(no output)' });
  }
  return blocks;
}
