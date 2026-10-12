import type { BenchAgent, BenchSession } from '../types.js';

/**
 * A single pre-recorded tool invocation.
 */
export interface ScriptedCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Replays fixed tool-call scripts keyed by task id. Useful for reference
 * solutions, regression baselines, and replaying transcripts captured from
 * other agent runtimes.
 */
export class ScriptedAgent implements BenchAgent {
  constructor(
    readonly name: string,
    private readonly scripts: Readonly<Record<string, ScriptedCall[]>>
  ) {}

  async run(session: BenchSession): Promise<void> {
    const script = this.scripts[session.task.id];
    if (!script) {
      throw new Error(`Scripted agent "${this.name}" has no script for task "${session.task.id}".`);
    }
    for (const call of script) {
      await session.callTool(call.tool, structuredClone(call.args));
    }
  }
}
