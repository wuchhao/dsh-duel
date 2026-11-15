/**
 * 插件配置：schemastery 声明（供 DSH 的插件配置界面与装配校验使用）
 * 加上一层解析与校验，得到各模块实际使用的 {@link ResolvedDuelConfig}。
 *
 * 配置字段与 README 保持一致：`writer.model` / `reviewer.model` /
 * `reviewer.isolation` / `gate.blockOn` / `gate.maxRounds` / `gate.escalate` /
 * `deliverables`。
 * @module dsh-duel/config
 */

import z from '@deepseek-ai/schemastery'
import { DELIVERABLE_KINDS, ESCALATIONS, SEVERITIES } from './types.js'
import type { DeliverableKind, Escalation, ModelRoute, Severity } from './types.js'
import { DUEL_ERROR_CODES, DuelError } from './errors.js'

/** 默认硬门禁级别：P0/P1 命中即打回。 */
export const DEFAULT_BLOCK_ON: readonly Severity[] = ['P0', 'P1']

/** 默认最大轮次：同一问题 3 轮未修透即升级。 */
export const DEFAULT_MAX_ROUNDS = 3

/** 默认子代理后端：`spawn` 是上下文隔离的独立子会话。 */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

/** 默认交付物目录（相对工作目录）。 */
export const DEFAULT_DELIVERABLE_DIR = '.dsh-duel'

/** 默认 diff 字符上限，防止把巨型 diff 塞进审核提示词。 */
export const DEFAULT_MAX_DIFF_CHARS = 200_000

/** 模型层配置字段，编写与审核共用。 */
export interface ModelConfig {
  /** LLM provider 路由名；留空继承父代理。 */
  provider?: string
  /** 模型 id；留空继承父代理。 */
  model?: string
  /** 单次回复的最大输出 token；留空用模型默认。 */
  maxTokens?: number
  /** 附加在该角色基础提示词之后的自定义要求。 */
  instruction?: string
}

/** 插件配置（全部字段可选，默认值在 {@link resolveConfig} 里落实）。 */
export interface Config {
  /** 编写层模型。 */
  writer?: ModelConfig
  /** 审核层模型。 */
  reviewer?: ModelConfig & {
    /** 上下文隔离：审核者只见产物、不见过程；默认 true。 */
    isolation?: boolean
  }
  /** 硬门禁。 */
  gate?: {
    /** 命中即打回的级别。 */
    blockOn?: string[]
    /** 同一问题最多循环几轮。 */
    maxRounds?: number
    /** 超轮次后的处置：human（升级人工）/ stop（停在原地）。 */
    escalate?: string
  }
  /** 需要落盘的交付物种类。 */
  deliverables?: string[]
  /** 子代理后端名（`spawn` / `fork` / 外部后端）。 */
  subagentProvider?: string
  /** 交付物根目录。 */
  deliverableDir?: string
  /** diff 字符上限。 */
  maxDiffChars?: number
  /** 单次子代理调用的协作超时（毫秒）；省略表示不设截止。 */
  timeoutMs?: number
}

/** 解析后的编写/审核路由。 */
export interface ResolvedRoleConfig {
  /** 模型路由。 */
  readonly route: ModelRoute
  /** 角色附加要求。 */
  readonly instruction: string
  /** 上下文隔离（仅审核角色有实际语义）。 */
  readonly isolation: boolean
}

/** 解析并校验后的配置。 */
export interface ResolvedDuelConfig {
  /** 编写层。 */
  readonly writer: ResolvedRoleConfig
  /** 审核层。 */
  readonly reviewer: ResolvedRoleConfig
  /** 硬门禁级别。 */
  readonly blockOn: readonly Severity[]
  /** 最大轮次。 */
  readonly maxRounds: number
  /** 升级方式。 */
  readonly escalate: Escalation
  /** 需落盘的交付物。 */
  readonly deliverables: readonly DeliverableKind[]
  /** 子代理后端名。 */
  readonly subagentProvider: string
  /** 交付物根目录。 */
  readonly deliverableDir: string
  /** diff 字符上限。 */
  readonly maxDiffChars: number
  /** 子代理协作超时（毫秒）；undefined 表示不设截止。 */
  readonly timeoutMs?: number
}

/** schemastery 配置声明。 */
export const Config = z.object({
  writer: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1),
    instruction: z.string(),
  }),
  reviewer: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1),
    instruction: z.string(),
    isolation: z.boolean().default(true),
  }),
  gate: z.object({
    blockOn: z.array(z.string()).default([...DEFAULT_BLOCK_ON]),
    maxRounds: z.number().step(1).min(1).max(10).default(DEFAULT_MAX_ROUNDS),
    escalate: z.string().default('human'),
  }),
  deliverables: z.array(z.string()).default([...DELIVERABLE_KINDS]),
  subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
  deliverableDir: z.string().default(DEFAULT_DELIVERABLE_DIR),
  maxDiffChars: z.number().step(1).min(1000).default(DEFAULT_MAX_DIFF_CHARS),
  timeoutMs: z.number().step(1).min(1),
})

/** 去掉空白并折叠空串为 undefined。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 校验一个可能非法的正整数。 */
function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DuelError(DUEL_ERROR_CODES.invalidConfig, `${field} 必须是正整数，收到 ${String(value)}`)
  }
  return value
}

/** 解析一个角色的模型路由。 */
function resolveRoute(config: ModelConfig | undefined, role: string): ModelRoute {
  const provider = nonEmpty(config?.provider)
  const model = nonEmpty(config?.model)
  if (config?.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)) {
    throw new DuelError(DUEL_ERROR_CODES.invalidConfig, `${role}.maxTokens 必须是正整数，收到 ${String(config.maxTokens)}`)
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(config?.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  }
}

/** 解析严重度列表；空列表与缺省都落到默认硬门禁。 */
function resolveBlockOn(values: readonly string[] | undefined): Severity[] {
  const list = values === undefined || values.length === 0 ? DEFAULT_BLOCK_ON : values
  const resolved: Severity[] = []
  for (const value of list) {
    const upper = value.trim().toUpperCase()
    if (!(SEVERITIES as readonly string[]).includes(upper)) {
      throw new DuelError(
        DUEL_ERROR_CODES.invalidConfig,
        `gate.blockOn 只接受 ${SEVERITIES.join('/')}，收到 "${value}"`,
      )
    }
    if (!resolved.includes(upper as Severity)) resolved.push(upper as Severity)
  }
  return resolved
}

/** 解析交付物种类列表；空列表与缺省都落到全部交付物。 */
function resolveDeliverables(values: readonly string[] | undefined): DeliverableKind[] {
  const list = values === undefined || values.length === 0 ? DELIVERABLE_KINDS : values
  const resolved: DeliverableKind[] = []
  for (const value of list) {
    if (!(DELIVERABLE_KINDS as readonly string[]).includes(value)) {
      throw new DuelError(
        DUEL_ERROR_CODES.invalidConfig,
        `deliverables 只接受 ${DELIVERABLE_KINDS.join('/')}，收到 "${value}"`,
      )
    }
    if (!resolved.includes(value as DeliverableKind)) resolved.push(value as DeliverableKind)
  }
  return resolved
}

/** 解析升级方式。 */
function resolveEscalation(value: string | undefined): Escalation {
  if (value === undefined) return 'human'
  const normalized = value.trim().toLowerCase()
  if (!(ESCALATIONS as readonly string[]).includes(normalized)) {
    throw new DuelError(
      DUEL_ERROR_CODES.invalidConfig,
      `gate.escalate 只接受 ${ESCALATIONS.join('/')}，收到 "${value}"`,
    )
  }
  return normalized as Escalation
}

/** 校验交付物目录：必须是工作目录内的相对路径（拒绝盘符、UNC、根相对与穿越）。 */
function resolveDeliverableDir(value: string | undefined): string {
  const dir = nonEmpty(value) ?? DEFAULT_DELIVERABLE_DIR
  const isRooted = /^[\\/]/.test(dir)
  const hasDrive = /^[A-Za-z]:/.test(dir)
  if (isRooted || hasDrive || dir.includes('..')) {
    throw new DuelError(
      DUEL_ERROR_CODES.invalidConfig,
      `deliverableDir 必须是工作目录内的相对路径（不能以斜杠/盘符开头，不能包含 ..），收到 "${dir}"`,
    )
  }
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 把 schema 校验后的原始配置解析成插件运行期配置。
 * @param raw - schemastery 归一化后的配置（可能缺省）。
 * @returns 补齐默认值并完成交叉校验的配置。
 * @throws {DuelError} 配置非法时，code 为 `DUEL_INVALID_CONFIG`。
 */
export function resolveConfig(raw: Config | undefined): ResolvedDuelConfig {
  const config = raw ?? {}
  const maxRounds = positiveInteger(config.gate?.maxRounds, DEFAULT_MAX_ROUNDS, 'gate.maxRounds')
  if (maxRounds > 10) {
    throw new DuelError(DUEL_ERROR_CODES.invalidConfig, `gate.maxRounds 不得超过 10，收到 ${maxRounds}`)
  }
  const maxDiffChars = positiveInteger(config.maxDiffChars, DEFAULT_MAX_DIFF_CHARS, 'maxDiffChars')
  const timeoutMs =
    config.timeoutMs === undefined ? undefined : positiveInteger(config.timeoutMs, 0, 'timeoutMs')

  return {
    writer: {
      route: resolveRoute(config.writer, 'writer'),
      instruction: nonEmpty(config.writer?.instruction) ?? '',
      isolation: false,
    },
    reviewer: {
      route: resolveRoute(config.reviewer, 'reviewer'),
      instruction: nonEmpty(config.reviewer?.instruction) ?? '',
      isolation: config.reviewer?.isolation ?? true,
    },
    blockOn: resolveBlockOn(config.gate?.blockOn),
    maxRounds,
    escalate: resolveEscalation(config.gate?.escalate),
    deliverables: resolveDeliverables(config.deliverables),
    subagentProvider: nonEmpty(config.subagentProvider) ?? DEFAULT_SUBAGENT_PROVIDER,
    deliverableDir: resolveDeliverableDir(config.deliverableDir),
    maxDiffChars,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

/** 把模型路由渲染成 `provider/model` 形式。 */
export function formatModelRoute(route: ModelRoute): string {
  const provider = route.provider ?? 'inherit'
  const model = route.model ?? 'inherit'
  return `${provider}/${model}`
}

/**
 * 校验部署层面的硬约束（文档要求）并给出软提示。
 *
 * 硬约束：`reviewer.isolation` 为 true 时不能用 `fork`——fork 会把父会话的
 * 已完成历史带进审核子会话，审核者就会看到编写过程与自查结论。
 *
 * @param config - 解析后的配置。
 * @returns 非阻塞告警（同路由、门禁未覆盖 P0/P1 等）。
 * @throws {DuelError} 隔离配置与后端矛盾时，code 为 `DUEL_INVALID_CONFIG`。
 */
export function validateDeployment(config: ResolvedDuelConfig): string[] {
  if (config.reviewer.isolation && config.subagentProvider === 'fork') {
    throw new DuelError(
      DUEL_ERROR_CODES.invalidConfig,
      'reviewer.isolation 为 true 时不能使用 fork 后端：fork 会继承父会话历史，审核者会看到编写过程。请改用 spawn（或其它独立后端），或显式设置 reviewer.isolation: false。',
    )
  }

  const warnings: string[] = []
  const writerRoute = config.writer.route
  const reviewerRoute = config.reviewer.route
  const effectiveWriterModel = writerRoute.model ?? 'inherit'
  const effectiveReviewerModel = reviewerRoute.model ?? 'inherit'
  const sameModel = effectiveWriterModel === effectiveReviewerModel
  const sameInstructions = config.writer.instruction === config.reviewer.instruction
  if (sameModel && sameInstructions) {
    warnings.push(
      `writer 与 reviewer 使用同一模型（${formatModelRoute(writerRoute)}）且提示词相同；文档要求至少异构一个维度，对抗性会变弱。请换模型或给两个角色不同的 instruction。`,
    )
  }

  if (!config.blockOn.includes('P0') || !config.blockOn.includes('P1')) {
    warnings.push(
      `gate.blockOn = [${config.blockOn.join(', ')}] 未包含 P0/P1；产品承诺的「P0/P1 硬门禁」被自定义门禁放宽，请确认这是有意为之。`,
    )
  }

  if (config.reviewer.isolation && config.subagentProvider !== 'spawn') {
    warnings.push(
      `reviewer.isolation 为 true 但 subagentProvider = "${config.subagentProvider}"；请确认该后端不继承父会话历史。`,
    )
  }
  return warnings
}
