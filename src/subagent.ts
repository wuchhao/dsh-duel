/**
 * 子代理执行层：把编写/审核提示词交给 `ctx.subagents` 的某个后端，拿到
 * 可等待的终态结果。
 *
 * 兼容两代 subagent 服务形态（两者的差别只在入口方法名与参数形状）：
 * - 新版：`startActivation(spec)` + `delivery: 'caller'`（结果只回给调用方，
 *   不再额外向父会话注入一条消息）；
 * - 早期版本：`start(provider, request)`。
 *
 * 两条路径都不依赖具体 provider：in-process 的 `spawn`/`fork` 与外部后端
 * （codex/claude-code/acp）都通过同一服务启动。
 * @module dsh-duel/subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAbortError, DUEL_ERROR_CODES, DuelError } from './errors.js'
import type { ModelRoute } from './types.js'

/** 发送给子代理的文本内容块。 */
interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 子代理终态结果的最小结构（各版本字段一致）。 */
interface ChildResultLike {
  readonly output?: readonly unknown[]
  readonly structured?: unknown
  readonly stopReason?: string
  readonly diagnostic?: string
}

/** 可等待的激活句柄。 */
interface ActivationLike {
  readonly childId?: unknown
  readonly name?: unknown
  readonly result: Promise<ChildResultLike>
  dispose(): Promise<void>
}

/** 早期版本的一次性运行句柄。 */
interface RunLike {
  readonly id?: unknown
  readonly result: Promise<ChildResultLike>
  dispose(): Promise<void>
}

/** 新旧两代服务入口的结构化描述。 */
interface SubagentServiceLike {
  startActivation?: (spec: Record<string, unknown>) => Promise<ActivationLike>
  start?: (provider: string, request: Record<string, unknown>) => Promise<RunLike>
  /** 后端注册表查询；早期服务也提供。 */
  getProvider?: (provider: string) => unknown
}

/** 一次子代理调用的请求。 */
export interface ChildRunRequest {
  /** 后端名（`spawn` / `fork` / 外部后端）。 */
  readonly provider: string
  /** 目录里显示的任务标签。 */
  readonly label: string
  /** 交给子代理的用户提示词。 */
  readonly prompt: string
  /** 子代理的模型路由；空对象表示继承父代理。 */
  readonly route: ModelRoute
  /** 父代理（决定工作目录、谱系与委派深度）。 */
  readonly parent: Agent
  /** 取消信号。 */
  readonly signal: AbortSignal
  /** 协作超时（毫秒）；0/undefined 表示不设截止。 */
  readonly timeoutMs?: number
}

/** 一次子代理调用的终态。 */
export interface ChildRunResult {
  /** 子代理最终回复的文本（非文本块被忽略）。 */
  readonly text: string
  /** 结束原因。 */
  readonly stopReason: string
  /** 子代理 id（可用于排障）。 */
  readonly childId: string | null
}

/** 读取 `ctx.subagents`；服务未加载时返回 undefined。 */
function getSubagentService(ctx: Context): SubagentServiceLike | undefined {
  const service = ctx.get('subagents') as SubagentServiceLike | undefined
  return service === undefined ? undefined : service
}

/** 判断服务是否提供任一入口。 */
function hasEntry(service: SubagentServiceLike | undefined): service is SubagentServiceLike {
  return service !== undefined && (typeof service.startActivation === 'function' || typeof service.start === 'function')
}

/** 把模型路由转换成子代理 `agentOptions`。 */
function toAgentOptions(route: ModelRoute): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {}
  if (route.provider !== undefined) options['provider'] = route.provider
  if (route.model !== undefined) options['model'] = route.model
  if (route.maxTokens !== undefined) options['maxTokens'] = route.maxTokens
  return Object.keys(options).length === 0 ? undefined : options
}

/** 汇总结果里的文本块。 */
function collectText(result: ChildResultLike): string {
  const parts: string[] = []
  for (const block of result.output ?? []) {
    if (typeof block === 'object' && block !== null) {
      const candidate = block as { type?: unknown; text?: unknown }
      if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    }
  }
  const text = parts.join('\n').trim()
  if (text.length > 0) return text
  if (result.structured !== undefined) return '```json\n' + JSON.stringify(result.structured, null, 2) + '\n```'
  return ''
}

/** 把失败原因映射成可分类错误。 */
function toFailure(result: ChildResultLike, label: string): Error {
  const reason = result.stopReason ?? 'error'
  if (reason === 'aborted') return createAbortError(`${label} 已取消`)
  const diagnostic = result.diagnostic !== undefined && result.diagnostic.length > 0 ? `：${result.diagnostic}` : ''
  return new DuelError(DUEL_ERROR_CODES.childFailed, `${label} 未正常结束（${reason}）${diagnostic}`)
}

/** 等待句柄结果，并始终释放它；取消信号触发时立刻让等待失败（不等 provider settle）。 */
async function settle(
  handle: ActivationLike | RunLike,
  label: string,
  childId: string | null,
  signal: AbortSignal,
): Promise<ChildRunResult> {
  try {
    const result = (await Promise.race([handle.result, abortPromise(signal)])) as ChildResultLike
    if ((result.stopReason ?? 'completed') !== 'completed') throw toFailure(result, label)
    return { text: collectText(result), stopReason: result.stopReason ?? 'completed', childId }
  } finally {
    try {
      await handle.dispose()
    } catch (error) {
      // 释放失败不覆盖已经拿到的执行结果；只留诊断。
      console.warn(`[dsh-duel] ${label} 释放失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 在信号触发时 reject 的 promise，用于给「等待 provider settle」加硬截止。 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    signal.addEventListener('abort', () => reject(createAbortError()), { once: true })
  })
}

/** 校验子代理返回的句柄形状；未知形状不能被当成成功。 */
function assertHandle(handle: unknown, label: string): asserts handle is ActivationLike | RunLike {
  const candidate = handle as Partial<ActivationLike & RunLike> | null | undefined
  const validResult = candidate !== null && candidate !== undefined && typeof candidate.result?.then === 'function'
  if (!validResult || typeof candidate.dispose !== 'function') {
    throw new DuelError(
      DUEL_ERROR_CODES.childFailed,
      `${label} 返回了无法识别的子代理句柄（缺少 result/dispose）；可能是 subagents 服务版本不兼容，请升级 dsh-subagent 或检查后端实现`,
    )
  }
}

/** 把服务层错误映射成稳定 code。 */
function mapServiceError(error: unknown, label: string): Error {
  if (error instanceof DuelError) return error
  if (error instanceof Error && error.name === 'AbortError') return error
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /provider|capabilit|unsupported|not.?found/i.test(code)) {
      return new DuelError(DUEL_ERROR_CODES.providerMissing, `${label} 启动失败（${code}）：${error.message}`, { cause: error })
    }
    return new DuelError(DUEL_ERROR_CODES.childFailed, `${label} 调用失败：${error.message}`, { cause: error })
  }
  return new DuelError(DUEL_ERROR_CODES.childFailed, `${label} 调用失败：${String(error)}`)
}

/**
 * 执行一个编写或审核子代理，等待其终态。
 * @param ctx - 插件上下文（用于取 subagents 服务）。
 * @param request - 后端、提示词、模型路由与取消信号。
 * @returns 子代理最终文本与结束原因。
 * @throws {DuelError} 服务缺失、子代理失败；取消时抛 `AbortError`。
 */
export async function runChild(ctx: Context, request: ChildRunRequest): Promise<ChildRunResult> {
  request.signal.throwIfAborted()
  const service = getSubagentService(ctx)
  if (!hasEntry(service)) {
    throw new DuelError(
      DUEL_ERROR_CODES.subagentsUnavailable,
      '宿主没有加载 subagents 服务；dsh-duel 需要子代理能力来跑编写/审核两个角色',
    )
  }

  const agentOptions = toAgentOptions(request.route)
  const prompt: TextBlock[] = [{ type: 'text', text: request.prompt }]
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(request.signal.reason)
  request.signal.addEventListener('abort', abortFromParent, { once: true })
  let timedOut = false
  const timer =
    request.timeoutMs !== undefined && request.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new Error('子代理调用超时'))
        }, request.timeoutMs)
      : undefined

  try {
    const spec: Record<string, unknown> = {
      provider: request.provider,
      label: request.label,
      prompt,
      parent: request.parent,
      signal: controller.signal,
      ...(agentOptions === undefined ? {} : { agentOptions }),
    }

    if (typeof service.startActivation === 'function') {
      const handle: unknown = await service.startActivation({ ...spec, delivery: 'caller' })
      assertHandle(handle, request.label)
      const activation = handle as ActivationLike
      if (timedOut) throw new DuelError(DUEL_ERROR_CODES.childFailed, `${request.label} 超时（${String(request.timeoutMs)}ms）`)
      return await settle(activation, request.label, typeof activation.childId === 'string' ? activation.childId : null, controller.signal)
    }

    if (typeof service.start === 'function') {
      const handle: unknown = await service.start(request.provider, spec)
      assertHandle(handle, request.label)
      const run = handle as RunLike
      if (timedOut) throw new DuelError(DUEL_ERROR_CODES.childFailed, `${request.label} 超时（${String(request.timeoutMs)}ms）`)
      return await settle(run, request.label, typeof run.id === 'string' ? run.id : null, controller.signal)
    }

    throw new DuelError(DUEL_ERROR_CODES.subagentsUnavailable, 'subagents 服务没有可用的启动入口')
  } catch (error) {
    if (timedOut) {
      throw new DuelError(DUEL_ERROR_CODES.childFailed, `${request.label} 超时（${String(request.timeoutMs)}ms）`, { cause: error })
    }
    if (request.signal.aborted) throw createAbortError(`${request.label} 已取消`)
    throw mapServiceError(error, request.label)
  } finally {
    request.signal.removeEventListener('abort', abortFromParent)
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 解析一个可用的子代理后端：优先配置值，缺失时按候选顺序回退。
 * @param ctx - 插件上下文。
 * @param preferred - 配置的后端名。
 * @param fallbacks - 允许回退的后端；上下文隔离场景必须只传 `['spawn']`。
 * @returns 服务上实际注册的后端名；服务未提供查询能力时原样返回配置值。
 */
export function resolveProvider(
  ctx: Context,
  preferred: string,
  fallbacks: readonly string[] = ['spawn', 'fork'],
): string {
  const service = getSubagentService(ctx)
  if (service === undefined || typeof service.getProvider !== 'function') return preferred
  if (service.getProvider(preferred) !== undefined) return preferred
  for (const candidate of fallbacks) {
    if (service.getProvider(candidate) !== undefined) return candidate
  }
  return preferred
}

/**
 * 解析父代理的工作目录：优先会话元信息里的 cwd，退回进程 cwd。
 * @param agent - 调用方代理。
 * @param fallback - 无元信息时的兜底目录。
 * @returns 绝对路径。
 */
export function resolveAgentCwd(agent: Agent | undefined, fallback: string): string {
  const session = (agent as unknown as { session?: { meta?: { cwd?: unknown } } } | undefined)?.session
  const cwd = session?.meta?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback
}
