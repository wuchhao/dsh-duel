/**
 * dsh-duel 领域类型：问题分级、变更集、交接包、审核报告、门禁结果。
 *
 * 这些类型是插件内部各模块（diff 捕获、提示词、报告解析、门禁、交付物、
 * 子代理编排）之间唯一的契约，也是 `duel_run` / `duel_review` 返回值
 * 的结构来源。
 * @module dsh-duel/types
 */

/** 审核问题分级，按严重度从高到低。 */
export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const

/** 一个审核问题的级别：P0 最高（可致接口静默失效/数据损坏/安全），P3 最低（风格）。 */
export type Severity = (typeof SEVERITIES)[number]

/** 插件产出的三类交付物。 */
export const DELIVERABLE_KINDS = ['delivery-package', 'review-report', 'response-table'] as const

/** 交付物种类：交接包、审核报告、编写响应表。 */
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

/** 门禁升级方式：`human` 交人工仲裁，`stop` 直接停在原地。 */
export const ESCALATIONS = ['human', 'stop'] as const

/** 门禁升级方式。 */
export type Escalation = (typeof ESCALATIONS)[number]

/** 审核者给出的最终结论。 */
export type ReviewVerdict = 'pass' | 'reject'

/** 一次循环的终态。 */
export type DuelStatus = 'passed' | 'escalated' | 'rejected' | 'error'

/** 单条审核问题。 */
export interface Issue {
  /** 稳定编号，如 `P0-1`；跨轮次保留，便于编写模型逐项响应。 */
  readonly id: string
  /** 严重度级别。 */
  readonly severity: Severity
  /** 问题是什么（现象 + 影响）。 */
  readonly problem: string
  /** 复现方式：实测命令、stub、探针、实测数字；没有就是「未实测」。 */
  readonly reproduce: string
  /** 修复建议。 */
  readonly suggestion: string
}

/** 编写模型对单条审核问题的响应。 */
export interface WriterResponse {
  /** 对应审核问题的编号。 */
  readonly id: string
  /** 处置：已修复 / 驳回 / 降级 / 遗留。 */
  readonly action: string
  /** 修改内容。 */
  readonly changes: string
  /** 验证方式（命令 + 结果，或说明为什么无法验证）。 */
  readonly verification: string
}

/** 编写模型机器可读的交接信息（从最终回复的 JSON 块解析）。 */
export interface WriterReport {
  /** 自测项清单（命令 + 运行方式），审核者会复跑。 */
  readonly selfTests: readonly string[]
  /** 变更文件 → 一句话摘要。 */
  readonly changeSummary: Readonly<Record<string, string>>
  /** 打回后的逐项响应；首轮为空。 */
  readonly responses: readonly WriterResponse[]
  /** 编写者最终回复原文，仅用于诊断，不进入交接包。 */
  readonly raw: string
}

/** 一个变更文件。 */
export interface FileChange {
  /** 相对仓库根的路径。 */
  readonly path: string
  /** 变更类型。 */
  readonly status: 'added' | 'modified' | 'deleted' | 'untracked'
  /** 新增行数（二进制/未知为 0）。 */
  readonly additions: number
  /** 删除行数（二进制/未知为 0）。 */
  readonly deletions: number
  /** 一句话摘要，来自编写模型的 `changeSummary`。 */
  readonly summary: string
}

/** 一次工作区变更快照。 */
export interface ChangeSet {
  /** git 仓库根目录。 */
  readonly repoRoot: string
  /** 捕获时的工作目录（子代理的 cwd）。 */
  readonly cwd: string
  /** 面向审核者的 diff 文本（含未跟踪文件内容）。 */
  readonly diff: string
  /** diff 是否因长度上限被截断。 */
  readonly truncated: boolean
  /** 变更文件清单。 */
  readonly files: readonly FileChange[]
}

/** 一次交接包（Writer → Reviewer 的唯一输入）。 */
export interface DeliveryPackage {
  /** 需求/目标。 */
  readonly requirement: string
  /** 验收标准。 */
  readonly acceptance: string
  /** 变更文件清单。 */
  readonly files: readonly FileChange[]
  /** 完整 diff。 */
  readonly diff: string
  /** diff 是否被截断。 */
  readonly truncated: boolean
  /** 自测清单。 */
  readonly selfTests: readonly string[]
  /** 本轮是第几轮。 */
  readonly round: number
}

/** 一次审核的解析结果。 */
export interface ReviewReport {
  /** 轮次。 */
  readonly round: number
  /** 审核结论。 */
  readonly verdict: ReviewVerdict
  /** 问题清单。 */
  readonly issues: readonly Issue[]
  /** 遗留项：原因 + 风险 + 触发条件。 */
  readonly residual: readonly string[]
  /** 审核者回复原文（作为审核报告交付物保存）。 */
  readonly raw: string
}

/** 门禁裁决。 */
export interface GateDecision {
  /** 是否打回编写。 */
  readonly blocked: boolean
  /** 命中的硬门禁问题（按 blockOn 过滤后）。 */
  readonly blocking: readonly Issue[]
}

/** 一次 `duel_run` 的终态摘要（也是工具的规范返回值）。 */
export interface DuelRunResult {
  /** 终态。 */
  readonly status: DuelStatus
  /** 实际跑了几轮。 */
  readonly rounds: number
  /** 交付物目录；未产生任何交付物时为 null。 */
  readonly runDir: string | null
  /** 已写出的交付物文件（相对 runDir）。 */
  readonly files: readonly string[]
  /** 最后一轮的问题清单。 */
  readonly issues: readonly Issue[]
  /** 最后一轮命中硬门禁的问题。 */
  readonly blocking: readonly Issue[]
  /** 人读摘要（Markdown）。 */
  readonly summary: string
  /** 编写模型标识（`provider/model` 或继承）。 */
  readonly writerModel: string
  /** 审核模型标识（`provider/model` 或继承）。 */
  readonly reviewerModel: string
}

/** 传给子代理的模型路由；字段缺省表示继承父代理。 */
export interface ModelRoute {
  /** LLM provider 路由名。 */
  readonly provider?: string
  /** 模型 id。 */
  readonly model?: string
  /** 单次回复的最大输出 token。 */
  readonly maxTokens?: number
}
