import type { SuiteResult, TaskResult } from './types.js';

/**
 * Options for terminal report formatting.
 */
export interface ReportFormatOptions {
  /** Emit ANSI colors (default: true unless `NO_COLOR` is set). */
  color?: boolean;
  /** Include the per-call log for each task (default false). */
  verbose?: boolean;
}

/**
 * Formats a suite result as a deterministic, human-readable terminal report.
 */
export function formatBenchReport(result: SuiteResult, options: ReportFormatOptions = {}): string {
  const useColor = options.color ?? !process.env.NO_COLOR;
  const paint = (code: string, text: string): string => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const dim = (t: string): string => paint('2', t);
  const cyan = (t: string): string => paint('36', t);
  const scoreColor = (score: number): string =>
    paint(score >= 90 ? '32' : score >= 70 ? '33' : '31', String(score).padStart(3));

  const lines: string[] = [];
  lines.push('');
  lines.push(` VitraBench report  agent ${cyan(result.agent)}`);
  lines.push(dim('┌──────────────────────┬───────┬────────┬───────┬────────┬────────┬───────┬────────┐'));
  lines.push(
    `${dim('│')} ${'task'.padEnd(20)} ${dim('│')} score ${dim('│')} checks ${dim('│')} audit ${dim('│')} visual ${dim('│')} effic. ${dim('│')} calls ${dim('│')} wasted ${dim('│')}`
  );
  lines.push(dim('├──────────────────────┼───────┼────────┼───────┼────────┼────────┼───────┼────────┤'));
  for (const task of result.tasks) {
    const passed = task.checks.filter((c) => c.passed).length;
    lines.push(
      [
        dim('│'),
        task.taskId.padEnd(20).slice(0, 20),
        dim('│'),
        `  ${scoreColor(task.score)}`,
        dim('│'),
        `${passed}/${task.checks.length}`.padStart(6),
        dim('│'),
        String(task.auditScore).padStart(5),
        dim('│'),
        task.visual.ssim.toFixed(3).padStart(6),
        dim('│'),
        String(task.efficiency.score).padStart(6),
        dim('│'),
        String(task.efficiency.totalCalls).padStart(5),
        dim('│'),
        String(task.efficiency.wastedCalls).padStart(6),
        dim('│'),
      ].join(' ')
    );
  }
  lines.push(dim('└──────────────────────┴───────┴────────┴───────┴────────┴────────┴───────┴────────┘'));
  lines.push(` Suite score: ${scoreColor(result.score)}/100`);

  for (const task of result.tasks) {
    lines.push('');
    lines.push(formatTaskDetail(task, paint, options.verbose ?? false));
  }
  lines.push('');
  return lines.join('\n');
}

function formatTaskDetail(
  task: TaskResult,
  paint: (code: string, text: string) => string,
  verbose: boolean
): string {
  const lines: string[] = [];
  const ok = paint('32', '✔');
  const bad = paint('31', '✕');
  lines.push(` ${task.taskId} ${paint('2', `(${task.category}) ${task.title}`)}`);
  for (const check of task.checks) {
    lines.push(`   ${check.passed ? ok : bad} ${check.description}${paint('2', `  ${check.detail}`)}`);
  }
  const issues = task.audit?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error').length;
  lines.push(
    paint(
      '2',
      `   audit ${task.auditScore}/100 (${errors} error(s), ${issues.length - errors} other)` +
        `  visual ssim ${task.visual.ssim.toFixed(4)} size ratio ${task.visual.sizeRatio.toFixed(3)}` +
        (task.visual.error ? ` [${task.visual.error}]` : '')
    )
  );
  const e = task.efficiency;
  lines.push(
    paint(
      '2',
      `   calls ${e.totalCalls}/${e.callBudget} budget, ${e.mutatingCalls} mutating, ` +
        `${e.failedCalls} failed, ${e.noOpCalls} no-op, ${e.supersededCalls} superseded`
    )
  );
  if (task.usage) {
    lines.push(paint('2', `   tokens ${task.usage.inputTokens} in / ${task.usage.outputTokens} out`));
  }
  if (task.agentError) {
    lines.push(`   ${paint('33', '!')} agent error: ${task.agentError}`);
  }
  if (verbose) {
    for (const call of task.calls) {
      const flag = call.wasted ? paint('33', ` [${call.wasted}]`) : '';
      lines.push(paint('2', `   ${String(call.index + 1).padStart(3)}. ${call.name}`) + flag);
    }
  }
  return lines.join('\n');
}
