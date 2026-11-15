/**
 * 模型可调用工具：`duel_run`（完整编写-审核闭环）与 `duel_review`
 * （只审核当前 diff，不改代码）。
 *
 * 工具的规范返回值就是 {@link DuelRunResult}，模型与程序化调用方都直接拿到
 * 结构化的终态、问题清单与交付物位置；`render` 只负责生成人读摘要。
 * @module dsh-duel/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ResolvedDuelConfig } from './config.js'
import { runDuel, runReview } from './loop.js'
import type { DuelRunResult } from './types.js'

/** 工具注册时暴露给模型的用法说明（同时进入系统提示词）。 */
export const DUEL_GUIDANCE = `Use duel_run to run the writer↔reviewer adversarial loop on a code change: the plugin hands the requirement to a writer subagent, captures the git diff, then has an isolated reviewer subagent re-verify it against the hard checklist. The loop writes back only when P0/P1 issues exist and escalates after maxRounds. Use duel_review to audit the current diff without changing code. Deliverables are written under .dsh-duel/runs/. Never treat a self-claim from the writer as evidence; the report cites measured reproduction.`

/** 单个问题的规范输出 schema。 */
const issueValueSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    severity: { type: 'string' as const, required: true as const, enum: ['P0', 'P1', 'P2', 'P3'] },
    problem: { type: 'string' as const, required: true as const },
    reproduce: { type: 'string' as const, required: true as const },
    suggestion: { type: 'string' as const, required: true as const },
  },
}

/** 工具规范返回值 schema。 */
const duelOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    status: { type: 'string' as const, required: true as const, enum: ['passed', 'escalated', 'rejected', 'error'] },
    rounds: { type: 'number' as const, required: true as const },
    runDir: { type: 'string' as const, required: true as const },
    files: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
    issues: { type: 'array' as const, required: true as const, items: issueValueSchema },
    blocking: { type: 'array' as const, required: true as const, items: issueValueSchema },
    summary: { type: 'string' as const, required: true as const },
    writerModel: { type: 'string' as const, required: true as const },
    reviewerModel: { type: 'string' as const, required: true as const },
  },
}

/** 把领域结果转换成规范输出值（数组可变，字段齐全）。 */
function toOutputValue(result: DuelRunResult): {
  status: DuelRunResult['status']
  rounds: number
  runDir: string
  files: string[]
  issues: DuelRunResult['issues'][number][]
  blocking: DuelRunResult['issues'][number][]
  summary: string
  writerModel: string
  reviewerModel: string
} {
  return {
    status: result.status,
    rounds: result.rounds,
    runDir: result.runDir ?? '',
    files: [...result.files],
    issues: result.issues.map((issue) => ({ ...issue })),
    blocking: result.blocking.map((issue) => ({ ...issue })),
    summary: result.summary,
    writerModel: result.writerModel,
    reviewerModel: result.reviewerModel,
  }
}

/**
 * 注册两个模型可调用工具。注册随插件 fiber 释放。
 * @param ctx - 携带 tools 注册表的上下文。
 * @param config - 解析后的插件配置。
 */
export function applyDuelTools(ctx: Context, config: ResolvedDuelConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'duel_run',
      description:
        'Run the dsh-duel writer↔reviewer loop: a writer subagent implements the requirement, an isolated reviewer subagent audits the git diff against the hard checklist, and P0/P1 issues send the work back to the writer until the gate passes or maxRounds is reached. Returns the terminal status, graded issues and the deliverables directory.',
      parameters: {
        requirement: {
          type: 'string',
          required: true,
          description: '一句话目标 + 验收标准（会原样交给编写模型与审核模型）。',
        },
        acceptance: {
          type: 'string',
          description: '可观察的验收标准；省略则以需求描述为准。',
        },
        maxRounds: {
          type: 'number',
          description: '覆盖本次最大轮次（1..10）；省略用插件配置的 gate.maxRounds。',
        },
      },
      output: {
        schema: duelOutputSchema,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const requirement = args.requirement.trim()
        if (requirement.length === 0) throw new ToolArgsError(['requirement 不能为空'])
        const maxRounds = args.maxRounds
        if (maxRounds !== undefined && (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10)) {
          throw new ToolArgsError(['maxRounds 必须是 1..10 的整数'])
        }
        const acceptance = args.acceptance?.trim()
        const result = await runDuel(ctx, config, {
          requirement,
          ...(acceptance === undefined || acceptance.length === 0 ? {} : { acceptance }),
          ...(maxRounds === undefined ? {} : { maxRounds }),
          agent: exec.agent,
          signal: exec.signal,
        })
        return toOutputValue(result)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'duel_review',
      description:
        'Run one isolated dsh-duel review of the current working-tree diff (no writer, no code changes). Returns graded issues and the review report path under .dsh-duel/runs/.',
      parameters: {
        requirement: {
          type: 'string',
          description: '需求/目标；省略时审核者按 diff 自洽性判断。',
        },
        acceptance: {
          type: 'string',
          description: '验收标准（可选）。',
        },
        diff: {
          type: 'string',
          description: '直接指定 diff 文本；省略则从工作区捕获。',
        },
      },
      output: {
        schema: duelOutputSchema,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const requirement = args.requirement?.trim()
        const acceptance = args.acceptance?.trim()
        const diff = args.diff
        const result = await runReview(ctx, config, {
          ...(requirement === undefined || requirement.length === 0 ? {} : { requirement }),
          ...(acceptance === undefined || acceptance.length === 0 ? {} : { acceptance }),
          ...(diff === undefined || diff.trim().length === 0 ? {} : { diff }),
          agent: exec.agent,
          signal: exec.signal,
        })
        return toOutputValue(result)
      },
    }),
  )
}
