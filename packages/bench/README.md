# @vitra/bench

VitraBench is an evaluation harness for agents that operate Vitra through its Model Context Protocol tools. It answers a question the rest of the toolchain cannot: given the same brief and the same starting scene, how well and how economically does an agent produce the requested interface?

## How a run works

For every task the harness:

1. Builds an isolated in-memory scene from the task fixture and registers its design tokens.
2. Starts an in-process Vitra MCP server (`createVitraServer`) over a linked in-memory transport.
3. Hands the agent a `BenchSession`: the task prompt, the advertised tool list, a compact JSON description of the starting scene, and a `callTool` function.
4. Records every tool call with a scene snapshot before and after it.
5. Scores the final scene once the agent returns, throws, or exceeds its time limit.

Partial progress is always scored, so an agent that crashes halfway is still measured on what it built.

## Scoring

Each task produces four sub-scores in the range 0-100.

| Sub-score | Weight | Definition |
|:---|:---:|:---|
| Functional | 0.40 | Weighted goal-check credit multiplied by weighted guard-check credit |
| Audit | 0.20 | `auditDesign` score of the task's target node (0 if the node is missing) |
| Visual | 0.25 | `100 * SSIM * sqrt(sizeRatio)` between the agent's render and the reference render |
| Efficiency | 0.15 | `50 * min(1, budget / calls) + 50 * (1 - wasted / calls)` |

The composite is:

```text
score = 0.40 * functional + goalCompletion * (0.20 * audit + 0.25 * visual + 0.15 * efficiency)
```

`goalCompletion` is the weighted goal-check credit in [0, 1]. Gating the quality sub-scores on it prevents an agent from collecting audit, visual, or efficiency credit for a scene it never changed; an idle agent scores 0 on every task.

### Checks

Each task defines deterministic checks over the final scene:

- **Goal checks** measure whether the requested change was made. They may award partial `credit`; for example `tokenize-colors` credits the fraction of colors migrated.
- **Guard checks** measure that nothing else was broken, such as an untouched source artboard or an unchanged node hierarchy. They multiply the functional score but cannot earn credit on their own.

### Visual similarity

The target node is rendered through the production pipeline (`computeLayout` and `renderToPng`), decoded with a dependency-free PNG decoder, resampled to the reference size, and compared with mean SSIM over 8x8 luma windows (Wang et al., 2004). Transparent pixels are composited over white. Because resampling hides size differences, the score is multiplied by the square root of the area ratio between the two renders.

SSIM is the default `ImageSimilarityMetric`. A perceptual metric such as CLIP embedding cosine similarity can be supplied through `RunOptions.visualMetric` without adding a model dependency to this package.

### Tool-call efficiency

Every call is classified after the run:

| Classification | Meaning |
|:---|:---|
| `error` | The tool returned an error result |
| `no-op` | A mutating tool succeeded but changed nothing |
| `superseded` | Every property the call edited was edited again later (overwritten, reverted, or the node was deleted) |

Edits are tracked at property granularity (`<nodeId>.<prop>`, `<nodeId>#exists`, `<nodeId>#parent`, and token paths), so creating a node and then styling it is not waste, but setting the same fill twice is. Read-only calls such as `audit_design` and `render_viewport` are never waste but do count against the call budget, which includes one verification call.

## Built-in tasks

| Id | Category | Brief |
|:---|:---|:---|
| `pricing-card` | compose | Build a pricing card with plan, price, three features, and a CTA button |
| `responsive-mobile` | responsive | Adapt a three-column desktop section to a single-column 375px artboard |
| `tokenize-colors` | tokens | Replace hardcoded hex colors with matching token references, leaving untokenized colors literal |

Each task ships a reference tool-call script. The `oracle` agent replays these scripts and must score 100 on every task; the test suite enforces this as a self-check on the harness.

## Usage

### CLI

```bash
vitra bench --list
vitra bench --verbose
ANTHROPIC_API_KEY=... vitra bench --agent anthropic --model <model-id> --out bench.json
vitra bench --agent anthropic --task pricing-card --task tokenize-colors --min-score 80
```

| Option | Description |
|:---|:---|
| `--agent <oracle\|anthropic>` | Agent to evaluate (default `oracle`) |
| `--task <id>` | Run only this task; repeatable |
| `--model <id>` | Model for the `anthropic` agent (default `VITRA_BENCH_MODEL`, then the package default) |
| `--max-turns <n>` | Model turns per task before the run is abandoned (default 25) |
| `--timeout <ms>` | Per-task time limit |
| `--out <file>` | Write the full JSON result, including the call log |
| `--json` | Print the JSON result instead of the report |
| `--verbose` | Include the per-call log in the report |
| `--min-score <n>` | Exit with code 1 when the suite score is below `n` |

### Programmatic

```ts
import { BUILTIN_TASKS, runSuite, type BenchAgent } from '@vitra/bench';

const agent: BenchAgent = {
  name: 'my-agent',
  async run(session) {
    // session.task.prompt, session.sceneContext, session.tools
    await session.callTool('insert_component', { parentId: 'board', component: { /* ... */ } });
  },
};

const result = await runSuite([...BUILTIN_TASKS], agent, { timeoutMs: 120_000 });
console.log(result.score);
```

Agents that report model usage can implement `consumeUsage()` to have input and output token counts recorded per task. `ScriptedAgent` replays fixed tool-call scripts and is useful for regression baselines or for replaying transcripts captured from other agent runtimes.

### Anthropic agent

`AnthropicAgent` runs a Messages API tool-use loop using `fetch` directly, so the package takes no SDK dependency. It forwards `render_viewport` images to the model by default (`includeImages: false` disables this).

## Adding a task

A task is a `BenchTask` object:

- `fixture`: declarative node trees (and optional tokens) for the starting scene.
- `reference`: the full expected scene, rendered at `targetNodeId` as visual ground truth.
- `checks`: goal and guard checks over the final scene.
- `callBudget`: tool calls a competent agent needs, including one verification call.

Add a reference solution to `REFERENCE_SOLUTIONS` and register the task in `BUILTIN_TASKS`; the oracle test will then verify the task is solvable at 100.
