/**
 * dsh-duel 插件入口：一个 DeepSeek Harness 插件，实现「编写 ↔ 审核 ↔ 实证」
 * 的双模型对抗闭环。
 *
 * - 编写子代理改代码、写自测、跑自测；
 * - 审核子代理上下文隔离，只看交接包（需求 + diff + 自测），独立实测；
 * - P0/P1 硬门禁命中即打回，同一问题 maxRounds 轮未修透升级人工；
 * - 每轮落盘交接包 / 审核报告 / 响应表，便于事后审计。
 *
 * 规范来源：`docs/writer-reviewer-loop.md`、`docs/code-review-checklist.md`。
 * @module dsh-duel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig, validateDeployment } from './config.js'
import { applyDuelTools, DUEL_GUIDANCE } from './tools.js'

/** Cordis 插件名（加载器诊断与配置面板使用）。 */
export const name = 'dsh-duel'

/** 依赖的服务：工具注册表与系统提示词装配。subagents 在工具执行时按需检查。 */
export const inject = ['tools', 'systemPrompt']

export { Config, resolveConfig, validateDeployment, formatModelRoute, DEFAULT_BLOCK_ON, DEFAULT_MAX_ROUNDS, DEFAULT_SUBAGENT_PROVIDER } from './config.js'
export type { Config as DuelConfig, ModelConfig, ResolvedDuelConfig, ResolvedRoleConfig } from './config.js'
export { DUEL_ERROR_CODES, DuelError } from './errors.js'
export { DUEL_GUIDANCE, applyDuelTools } from './tools.js'
export { runDuel, runReview, buildPackage, annotateFiles, chooseReviewerProvider } from './loop.js'
export { captureChanges, filesFromDiff } from './diff.js'
export { buildDeliveryPackageMarkdown, buildReviewerTask, buildWriterTask, renderResponseTable, reviewerSystemPrompt, REVIEW_CHECKLIST } from './prompts.js'
export { evaluateGate, extractCodeBlocks, extractStructuredResult, normalizeSeverity, parseReviewReport, parseWriterReport, renderIssuesTable, renderReviewReportFile, renderRunSummary } from './report.js'
export { formatStamp, RunWorkspace } from './deliverables.js'
export { runChild, resolveAgentCwd, resolveProvider } from './subagent.js'
export * from './types.js'

/**
 * 装配插件：解析配置、注册工具、贡献系统提示词。
 * @param ctx - 插件上下文。
 * @param config - schemastery 校验后的配置。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const warnings = validateDeployment(resolved)
  for (const warning of warnings) {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.(`[dsh-duel] ${warning}`)
  }
  ctx.systemPrompt.section({
    name: 'tool:duel',
    order: 118,
    text: DUEL_GUIDANCE,
  })
  applyDuelTools(ctx, resolved)
}
