import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBenchAgent, formatBenchTaskList, runBenchCommand } from '../src/index.js';

describe('Vitra CLI: bench command', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('runs the oracle on selected tasks and writes a JSON report', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitra-bench-test-'));
    const out = path.join(tmpDir, 'reports', 'bench.json');
    const { result, outFile } = await runBenchCommand({ tasks: ['pricing-card'], out });

    expect(outFile).toBe(out);
    expect(result.agent).toBe('oracle');
    expect(result.tasks.map((t) => t.taskId)).toEqual(['pricing-card']);
    expect(result.score).toBe(100);

    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written.tasks[0].efficiency.totalCalls).toBe(2);
  });

  it('lists the built-in tasks', () => {
    const list = formatBenchTaskList();
    expect(list).toContain('pricing-card');
    expect(list).toContain('responsive-mobile');
    expect(list).toContain('tokenize-colors');
  });

  it('rejects unknown agents and tasks', async () => {
    expect(() => createBenchAgent('gpt')).toThrow(/Unknown bench agent "gpt"/);
    await expect(runBenchCommand({ tasks: ['missing'] })).rejects.toThrow(/Unknown bench task "missing"/);
  });
});
