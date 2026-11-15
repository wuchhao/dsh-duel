/**
 * 双模型循环编排：Writer 交付 → Reviewer 独立审核 → 硬门禁裁决 → 打回重写，
 * 直到 P0/P1 清零、达到最大轮次或人工介入。
 *
 * 与文档一致的关键行为：
 * - 审核者拿到的是交接包（需求 + 变更清单 + diff + 自测），不是编写过程；
 * - 审核上下文隔离时使用独立子会话（默认 `spawn`），不复用父会话历史；
 * - 打回时把审核报告全文交回编写者，编写者必须逐项响应；
 * - 同一问题 maxRounds 轮未修透 → 升级人工（`gate.escalate`）。
 * @module dsh-duel/loop
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { captureChanges, filesFromDiff } from './diff.js'
import { RunWorkspace, buildManifest } from './deliverables.js'
import { DUEL_ERROR_CODES, DuelError } from './errors.js'
import { formatModelRoute } from './config.js'
import type { ResolvedDuelConfig } from './config.js'
import {
  buildDeliveryPackageMarkdown,
  buildReviewerTask,
  buildWriterTask,
  renderResponseTable,
  reviewerSystemPrompt,
  WRITER_SYSTEM_PROMPT,
} from './prompts.js'
import {
  evaluateGate,
  parseReviewReport,
  parseWriterReport,
  renderReviewReportFile,
  renderRunSummary,
  workspaceMutated,
} from './report.js'
import { resolveAgentCwd, resolveProvider, runChild } from './subagent.js'
import type { ChangeSet, DeliveryPackage, DuelRunResult, FileChange, ReviewReport } from './types.js'

/** `duel_run` 的输入。 */
export interface DuelRunInput {
  /** 需求/目标一句话。 */
  readonly requirement: string
  /** 验收标准。 */
  readonly acceptance?: string
  /** 覆盖本轮最大轮次（1..10）。 */
  readonly maxRounds?: number
  /** 调用方代理；子代理必须挂在它下面。 */
  readonly agent?: Agent
  /** 取消信号。 */
  readonly signal: AbortSignal
}

/** `duel_review` 的输入。 */
export interface DuelReviewInput {
  /** 需求描述（可省略，审核者会按 diff 判断）。 */
  readonly requirement?: string
  /** 验收标准。 */
  readonly acceptance?: string
  /** 直接给出 diff；省略则从工作区捕获。 */
  readonly diff?: string
  /** 调用方代理。 */
  readonly agent?: Agent
  /** 取消信号。 */
  readonly signal: AbortSignal
}

/** 读取子代理服务上的 provider 查询能力。 */
function hasProvider(ctx: Context, name: string): boolean {
  const service = ctx.get('subagents') as { getProvider?: (provider: string) => unknown } | undefined
  if (service === undefined || typeof service.getProvider !== 'function') return false
  return service.getProvider(name) !== undefined
}

/** 审核者后端：隔离时只允许独立后端；不隔离时优先 `fork`（继承父会话历史）。 */
export function chooseReviewerProvider(ctx: Context, config: ResolvedDuelConfig): string {
  if (config.reviewer.isolation) {
    // 隔离场景绝不能回退到 fork：fork 会把父会话历史带进审核子会话。
    return resolveProvider(ctx, config.subagentProvider, ['spawn'])
  }
  return hasProvider(ctx, 'fork') ? 'fork' : resolveProvider(ctx, config.subagentProvider)
}

/** 把编写模型的摘要合并进变更清单。 */
export function annotateFiles(changes: ChangeSet, summary: Readonly<Record<string, string>>): FileChange[] {
  return changes.files.map((file) => {
    const direct = summary[file.path]
    if (direct !== undefined) return { ...file, summary: direct }
    const normalized = file.path.replace(/\\/g, '/')
    for (const [path, text] of Object.entries(summary)) {
      if (path.replace(/\\/g, '/') === normalized) return { ...file, summary: text }
    }
    return { ...file }
  })
}

/** 组装交接包。 */
export function buildPackage(input: {
  readonly requirement: string
  readonly acceptance: string
  readonly round: number
  readonly changes: ChangeSet
  readonly files: readonly FileChange[]
  readonly selfTests: readonly string[]
}): DeliveryPackage {
  return {
    requirement: input.requirement,
    acceptance: input.acceptance,
    round: input.round,
    files: input.files,
    diff: input.changes.diff,
    truncated: input.changes.truncated,
    selfTests: input.selfTests,
  }
}

/** 把系统提示词与角色附加要求拼成子代理的用户提示词。 */
function composePrompt(system: string, instruction: string, task: string): string {
  return [system, instruction, task].filter((part) => part.trim().length > 0).join('\n\n---\n\n')
}

/** 完成一次 `duel_run`。 */
export async function runDuel(ctx: Context, config: ResolvedDuelConfig, input: DuelRunInput): Promise<DuelRunResult> {
  const agent = input.agent
  if (agent === undefined) {
    throw new DuelError(
      DUEL_ERROR_CODES.noParentAgent,
      'duel_run 需要调用方 Agent 才能派生编写/审核子代理（不能在无代理的程序化调用里直接使用）',
    )
  }
  const cwd = resolveAgentCwd(agent, process.cwd())
  const requirement = input.requirement.trim()
  const acceptance = (input.acceptance ?? '').trim()
  const maxRounds = input.maxRounds ?? config.maxRounds

  // 先捕获一次，确认是 git 工作树并拿到仓库根。
  const initial = await captureChanges({
    cwd,
    maxDiffChars: config.maxDiffChars,
    signal: input.signal,
    exclude: [config.deliverableDir],
  })
  const workspace = await RunWorkspace.create({
    root: initial.repoRoot,
    dir: config.deliverableDir,
    enabled: config.deliverables,
  })
  const writerModel = formatModelRoute(config.writer.route)
  const reviewerModel = formatModelRoute(config.reviewer.route)
  const writerProvider = resolveProvider(ctx, config.subagentProvider)
  const reviewerProvider = chooseReviewerProvider(ctx, config)
  if (writerProvider !== config.subagentProvider || reviewerProvider !== config.subagentProvider) {
    console.warn(
      `[dsh-duel] 子代理后端回退：配置 "${config.subagentProvider}"，实际 writer=${writerProvider}、reviewer=${reviewerProvider}`,
    )
  }
  const startedAt = new Date().toISOString()
  const meta = { writerModel, reviewerModel }

  let lastReport: ReviewReport | undefined
  let status: DuelRunResult['status'] = 'error'
  let rounds = 0
  let reviewerMutated = false

  try {
    for (rounds = 1; rounds <= maxRounds; rounds++) {
      input.signal.throwIfAborted()

      const writerTask = buildWriterTask({
        requirement,
        acceptance,
        round: rounds,
        maxRounds,
        ...(lastReport === undefined ? {} : { priorReport: lastReport.raw }),
      })
      const writer = await runChild(ctx, {
        provider: writerProvider,
        label: `duel-writer-${rounds}`,
        prompt: composePrompt(WRITER_SYSTEM_PROMPT, config.writer.instruction, writerTask),
        route: config.writer.route,
        parent: agent,
        signal: input.signal,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      })
      const writerReport = parseWriterReport(writer.text)

      // 上一轮被打回 → 本轮编写者的响应表就是上一轮的交付物。
      if (lastReport !== undefined) {
        const table = renderResponseTable(
          writerReport.responses,
          lastReport.round,
          lastReport.issues.map((issue) => issue.id),
        )
        await workspace.write('response-table', `response-table-${lastReport.round}.md`, table)
      }

      const changes = await captureChanges({
        cwd,
        maxDiffChars: config.maxDiffChars,
        signal: input.signal,
        exclude: [config.deliverableDir],
      })
      if (rounds === 1 && changes.diff === initial.diff) {
        throw new DuelError(
          DUEL_ERROR_CODES.noChanges,
          '编写模型没有产生任何新改动：工作区 diff 与编写前基线一致。dsh-duel 只审核编写者真实产生的 diff；若编写者自行 git commit，请先还原成未提交改动；只审核已有改动请用 duel_review。',
        )
      }
      const files = annotateFiles(changes, writerReport.changeSummary)
      const pkg = buildPackage({
        requirement,
        acceptance,
        round: rounds,
        changes,
        files,
        selfTests: writerReport.selfTests,
      })
      const packageMarkdown = buildDeliveryPackageMarkdown(pkg, meta)
      await workspace.write('delivery-package', `delivery-package-${rounds}.md`, packageMarkdown)

      const reviewerTask = buildReviewerTask({
        packageMarkdown,
        round: rounds,
        maxRounds,
        ...(config.reviewer.instruction.length === 0 ? {} : { instruction: config.reviewer.instruction }),
      })
      const reviewer = await runChild(ctx, {
        provider: reviewerProvider,
        label: `duel-reviewer-${rounds}`,
        prompt: composePrompt(reviewerSystemPrompt(config.reviewer.isolation), '', reviewerTask),
        route: config.reviewer.route,
        parent: agent,
        signal: input.signal,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      })
      const report = parseReviewReport(reviewer.text, rounds)
      await workspace.write('review-report', `review-report-${rounds}.md`, renderReviewReportFile(report, meta))

      // 上下文隔离的审核者不应改动工作区。一旦检测到改动，本轮报告不再可信：
      // 按隔离违规升级人工，不按报告继续放行。
      const after = await captureChanges({
        cwd,
        maxDiffChars: config.maxDiffChars,
        signal: input.signal,
        exclude: [config.deliverableDir],
      })
      if (workspaceMutated(changes.diff, after.diff)) {
        reviewerMutated = true
        lastReport = report
        status = 'escalated'
        console.warn(`[dsh-duel] 第 ${rounds} 轮审核者改动了工作区；审核报告不再可信，升级人工`)
        break
      }

      lastReport = report
      const gate = evaluateGate(report, config.blockOn)
      if (!gate.blocked) {
        status = 'passed'
        break
      }
      if (rounds >= maxRounds) {
        status = config.escalate === 'human' ? 'escalated' : 'rejected'
        break
      }
    }

    const resultWithoutSummary: Omit<DuelRunResult, 'summary'> = {
      status,
      rounds,
      runDir: workspace.directory,
      files: [...workspace.files],
      issues: lastReport?.issues ?? [],
      blocking: lastReport === undefined ? [] : evaluateGate(lastReport, config.blockOn).blocking,
      writerModel,
      reviewerModel,
    }
    const warnings = reviewerMutated ? ['审核者改动了工作区（违反隔离约束），审核报告不可信，已升级人工'] : []
    await workspace.writeManifest(
      buildManifest({
        requirement,
        acceptance,
        writerModel,
        reviewerModel,
        status,
        rounds,
        blocking: resultWithoutSummary.blocking.map((issue) => issue.id),
        files: [...workspace.files],
        startedAt,
        reviewerMutated,
        warnings,
      }),
    )
    const summary = renderRunSummary(resultWithoutSummary, config.blockOn) + (warnings.length > 0 ? '\n\n> ⚠ ' + warnings.join('；') : '')
    return { ...resultWithoutSummary, files: [...workspace.files], summary }
  } catch (error) {
    await workspace
      .writeManifest(
        buildManifest({
          requirement,
          acceptance,
          writerModel,
          reviewerModel,
          status: 'error',
          rounds,
          blocking: [],
          files: [...workspace.files],
          startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .catch(() => undefined)
    throw error
  }
}

/** 完成一次独立审核（不写代码，只审核当前 diff）。 */
export async function runReview(
  ctx: Context,
  config: ResolvedDuelConfig,
  input: DuelReviewInput,
): Promise<DuelRunResult> {
  const agent = input.agent
  if (agent === undefined) {
    throw new DuelError(DUEL_ERROR_CODES.noParentAgent, 'duel_review 需要调用方 Agent 才能派生审核子代理')
  }
  const cwd = resolveAgentCwd(agent, process.cwd())
  const requirement = (input.requirement ?? '').trim()
  const acceptance = (input.acceptance ?? '').trim()
  const changes: ChangeSet =
    input.diff !== undefined && input.diff.trim().length > 0
      ? {
          repoRoot: cwd,
          cwd,
          diff: input.diff,
          truncated: false,
          files: filesFromDiff(input.diff),
        }
      : await captureChanges({
          cwd,
          maxDiffChars: config.maxDiffChars,
          signal: input.signal,
          exclude: [config.deliverableDir],
        })

  const workspace = await RunWorkspace.create({
    root: changes.repoRoot,
    dir: config.deliverableDir,
    enabled: config.deliverables,
  })
  const writerModel = formatModelRoute(config.writer.route)
  const reviewerModel = formatModelRoute(config.reviewer.route)
  const meta = { writerModel, reviewerModel }
  const startedAt = new Date().toISOString()
  const pkg = buildPackage({
    requirement: requirement.length > 0 ? requirement : '（未提供需求描述；按 diff 判断改动是否自洽）',
    acceptance,
    round: 1,
    changes,
    files: changes.files,
    selfTests: [],
  })
  const packageMarkdown = buildDeliveryPackageMarkdown(pkg, meta)
  await workspace.write('delivery-package', 'delivery-package-1.md', packageMarkdown)

  try {
    const reviewer = await runChild(ctx, {
      provider: chooseReviewerProvider(ctx, config),
      label: 'duel-reviewer-1',
      prompt: composePrompt(
        reviewerSystemPrompt(config.reviewer.isolation),
        '',
        buildReviewerTask({
          packageMarkdown,
          round: 1,
          maxRounds: 1,
          ...(config.reviewer.instruction.length === 0 ? {} : { instruction: config.reviewer.instruction }),
        }),
      ),
      route: config.reviewer.route,
      parent: agent,
      signal: input.signal,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    })
    const report = parseReviewReport(reviewer.text, 1)
    await workspace.write('review-report', 'review-report-1.md', renderReviewReportFile(report, meta))

    // duel_review 同样要防审核者改动工作区。
    let reviewerMutated = false
    if (input.diff === undefined) {
      const after = await captureChanges({
        cwd,
        maxDiffChars: config.maxDiffChars,
        signal: input.signal,
        exclude: [config.deliverableDir],
      })
      reviewerMutated = workspaceMutated(changes.diff, after.diff)
    }

    const gate = evaluateGate(report, config.blockOn)
    const status: DuelRunResult['status'] = reviewerMutated ? 'escalated' : gate.blocked ? 'rejected' : 'passed'
    const resultWithoutSummary: Omit<DuelRunResult, 'summary'> = {
      status,
      rounds: 1,
      runDir: workspace.directory,
      files: [...workspace.files],
      issues: report.issues,
      blocking: gate.blocking,
      writerModel,
      reviewerModel,
    }
    await workspace.writeManifest(
      buildManifest({
        requirement,
        acceptance,
        writerModel,
        reviewerModel,
        status,
        rounds: 1,
        blocking: gate.blocking.map((issue) => issue.id),
        files: [...workspace.files],
        startedAt,
        mode: 'review-only',
        reviewerMutated,
      }),
    )
    const warnings = reviewerMutated ? ['审核者改动了工作区（违反隔离约束），审核报告不可信，请人工复核'] : []
    return {
      ...resultWithoutSummary,
      files: [...workspace.files],
      summary: renderRunSummary(resultWithoutSummary, config.blockOn) + (warnings.length > 0 ? '\n\n> ⚠ ' + warnings.join('；') : ''),
    }
  } catch (error) {
    await workspace
      .writeManifest(
        buildManifest({
          requirement,
          acceptance,
          writerModel,
          reviewerModel,
          status: 'error',
          rounds: 1,
          blocking: [],
          files: [...workspace.files],
          startedAt,
          mode: 'review-only',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .catch(() => undefined)
    throw error
  }
}
