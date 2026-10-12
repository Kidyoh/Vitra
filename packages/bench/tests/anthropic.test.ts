import { describe, it, expect } from 'vitest';
import { AnthropicAgent, pricingCardTask, runTask } from '../src/index.js';

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    system: string;
    tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
    messages: Array<{ role: string; content: unknown }>;
  };
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetch: impl as typeof fetch, requests };
}

const CARD = {
  id: 'pricing-card',
  type: 'frame',
  width: 320,
  fill: '#1E1E2E',
  layout: { direction: 'vertical', gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 } },
  children: [{ id: 'plan', type: 'text', text: 'Pro', fill: '#FFFFFF' }],
};

describe('AnthropicAgent', () => {
  it('runs the tool-use loop through the harness and reports token usage', async () => {
    const { fetch, requests } = mockFetch([
      {
        body: {
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [
            { type: 'text', text: 'Building the card.' },
            { type: 'tool_use', id: 'tu_1', name: 'insert_component', input: { parentId: 'board', component: CARD } },
            { type: 'tool_use', id: 'tu_2', name: 'update_node', input: { nodeId: 'does-not-exist', patch: {} } },
          ],
        },
      },
      {
        body: {
          stop_reason: 'end_turn',
          usage: { input_tokens: 150, output_tokens: 10 },
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    ]);
    const agent = new AnthropicAgent({ apiKey: 'test-key', model: 'test-model', fetch, baseUrl: 'https://example.test/' });
    const result = await runTask(pricingCardTask, agent);

    expect(agent.name).toBe('anthropic:test-model');
    expect(result.agentError).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
    expect(result.calls.map((c) => c.name)).toEqual(['insert_component', 'update_node']);
    expect(result.calls[1]!.wasted).toBe('error');
    expect(result.checks.find((c) => c.id === 'card-exists')!.passed).toBe(true);

    expect(requests).toHaveLength(2);
    const first = requests[0]!;
    expect(first.url).toBe('https://example.test/v1/messages');
    expect(first.headers['x-api-key']).toBe('test-key');
    expect(first.headers['anthropic-version']).toBe('2023-06-01');
    expect(first.body.model).toBe('test-model');
    expect(first.body.tools.map((t) => t.name)).toContain('insert_component');
    expect(first.body.tools.every((t) => t.input_schema.type === 'object')).toBe(true);
    expect(String(first.body.messages[0]!.content)).toContain(pricingCardTask.prompt);
    expect(String(first.body.messages[0]!.content)).toContain('"id":"board"');

    const toolResults = requests[1]!.body.messages[2]!.content as Array<{ tool_use_id: string; is_error: boolean }>;
    expect(toolResults.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ['tu_1', false],
      ['tu_2', true],
    ]);
  });

  it('fails the run with a clear error when no API key is configured', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runTask(pricingCardTask, new AnthropicAgent({ model: 'm' }));
      expect(result.agentError).toMatch(/ANTHROPIC_API_KEY/);
      expect(result.score).toBe(0);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('surfaces HTTP errors from the API', async () => {
    const { fetch } = mockFetch([{ status: 529, body: { error: { type: 'overloaded_error' } } }]);
    const result = await runTask(pricingCardTask, new AnthropicAgent({ apiKey: 'k', model: 'm', fetch }));
    expect(result.agentError).toMatch(/HTTP 529/);
  });

  it('stops after the configured number of turns', async () => {
    const loop = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'audit_design', input: { nodeId: 'board' } }],
    };
    const { fetch } = mockFetch([{ body: loop }, { body: loop }]);
    const result = await runTask(pricingCardTask, new AnthropicAgent({ apiKey: 'k', model: 'm', fetch, maxTurns: 2 }));
    expect(result.agentError).toMatch(/within 2 turns/);
    expect(result.efficiency.totalCalls).toBe(2);
  });
});
