/**
 * dsh-duel 的错误类型：所有预期失败都抛出带稳定 `code` 的 {@link DuelError}，
 * 继承 DSH 的 `HarnessError`，因此工具结果会保留 `error.name` 与 `error.code`。
 * @module dsh-duel/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** 插件对外承诺的稳定错误码；调用方按 code 路由，不要解析 message。 */
export const DUEL_ERROR_CODES = {
  /** 工作目录不在 git 仓库内，无法捕获 diff。 */
  notARepo: 'DUEL_NOT_A_REPO',
  /** 找不到 git 可执行文件。 */
  gitUnavailable: 'DUEL_GIT_UNAVAILABLE',
  /** 宿主未加载 subagents 服务。 */
  subagentsUnavailable: 'DUEL_SUBAGENTS_UNAVAILABLE',
  /** 找不到指定的子代理后端。 */
  providerMissing: 'DUEL_PROVIDER_MISSING',
  /** 工具调用没有调用方 Agent，无法派生编写/审核子代理。 */
  noParentAgent: 'DUEL_NO_PARENT_AGENT',
  /** 子代理非正常结束（模型/传输错误、token 上限、拒绝）。 */
  childFailed: 'DUEL_CHILD_FAILED',
  /** 审核者回复里找不到可解析的结构化报告。 */
  reviewUnparseable: 'DUEL_REVIEW_UNPARSEABLE',
  /** 编写轮次结束后工作区没有任何改动。 */
  noChanges: 'DUEL_NO_CHANGES',
  /** 插件配置非法。 */
  invalidConfig: 'DUEL_INVALID_CONFIG',
  /** 交付物写盘失败。 */
  deliverableFailed: 'DUEL_DELIVERABLE_FAILED',
} as const

/** 稳定错误码的联合类型。 */
export type DuelErrorCode = (typeof DUEL_ERROR_CODES)[keyof typeof DUEL_ERROR_CODES]

/** dsh-duel 的可分类错误。 */
export class DuelError extends HarnessError {
  constructor(code: DuelErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'DuelError'
  }
}

/** 构造一个 name 为 `AbortError` 的取消错误，保持工具层的取消语义。 */
export function createAbortError(message = 'duel 已取消'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}
