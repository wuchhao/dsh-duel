/**
 * 交付物落盘：每次 `duel_run` 在 `.dsh-duel/runs/<runId>/` 下写一套可追溯的
 * 交付物（交接包、审核报告、响应表）与 `manifest.json`。
 *
 * 目录按运行隔离，写入名限制在本次运行目录内；未启用交付物时静默跳过，
 * 但 `manifest.json` 始终记录终态，便于事后审计。
 * @module dsh-duel/deliverables
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DUEL_ERROR_CODES, DuelError } from './errors.js'
import type { DeliverableKind } from './types.js'

/** 构造运行目录的选项。 */
export interface RunWorkspaceOptions {
  /** 仓库根或工作目录，交付物目录相对于它。 */
  readonly root: string
  /** 交付物根目录（相对路径，如 `.dsh-duel`）。 */
  readonly dir: string
  /** 需要落盘的交付物种类。 */
  readonly enabled: readonly DeliverableKind[]
  /** 时钟注入，便于测试。 */
  readonly now?: () => Date
}

/** 一次运行的交付物目录。 */
export class RunWorkspace {
  /** 运行目录绝对路径。 */
  readonly directory: string
  /** 本次启用的交付物种类。 */
  private readonly enabled: Set<DeliverableKind>
  /** 已写出的文件名。 */
  private readonly written: string[] = []

  private constructor(directory: string, enabled: Set<DeliverableKind>) {
    this.directory = directory
    this.enabled = enabled
  }

  /**
   * 创建本次运行的目录。
   * @param options - 根目录、交付物目录与启用种类。
   * @returns 已创建目录的运行工作区。
   * @throws {DuelError} 写盘失败时 code 为 `DUEL_DELIVERABLE_FAILED`。
   */
  static async create(options: RunWorkspaceOptions): Promise<RunWorkspace> {
    const stamp = formatStamp(options.now?.() ?? new Date())
    const runId = `${stamp}-${randomBytes(3).toString('hex')}`
    const directory = resolve(options.root, options.dir, 'runs', runId)
    try {
      await mkdir(directory, { recursive: true })
    } catch (cause) {
      throw new DuelError(
        DUEL_ERROR_CODES.deliverableFailed,
        `无法创建交付物目录：${directory}`,
        { cause },
      )
    }
    return new RunWorkspace(directory, new Set(options.enabled))
  }

  /** 已写出的文件名（不含 manifest）。 */
  get files(): readonly string[] {
    return this.written
  }

  /**
   * 写一份交付物。
   * @param kind - 交付物种类；未启用时跳过。
   * @param name - 文件名（不得包含路径分隔符或 `..`）。
   * @param content - UTF-8 文本。
   * @returns 已写出的文件名；跳过时为 null。
   * @throws {DuelError} 文件名非法或写盘失败。
   */
  async write(kind: DeliverableKind, name: string, content: string): Promise<string | null> {
    if (!this.enabled.has(kind)) return null
    assertSafeName(name)
    const target = join(this.directory, name)
    try {
      await writeFile(target, content, 'utf8')
    } catch (cause) {
      throw new DuelError(DUEL_ERROR_CODES.deliverableFailed, `交付物写盘失败：${target}`, { cause })
    }
    this.written.push(name)
    return name
  }

  /**
   * 写运行清单（始终写出，不受 deliverables 过滤）。
   * @param manifest - 可序列化的运行元信息。
   * @returns 清单文件名。
   */
  async writeManifest(manifest: Record<string, unknown>): Promise<string> {
    const name = 'manifest.json'
    const target = join(this.directory, name)
    try {
      await writeFile(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    } catch (cause) {
      throw new DuelError(DUEL_ERROR_CODES.deliverableFailed, `运行清单写盘失败：${target}`, { cause })
    }
    this.written.push(name)
    return name
  }
}

/** 组装运行清单；字段由调用方决定，序列化为 JSON 后落盘。 */
export function buildManifest(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...input }))
}

/** 把时间格式化成文件系统安全的运行 id 前缀。 */
export function formatStamp(date: Date): string {
  const iso = date.toISOString()
  return iso.replace(/[-:]/g, '').replace(/\..+$/, 'Z')
}

/** 校验交付物文件名。 */
function assertSafeName(name: string): void {
  if (name.length === 0 || name.includes('..') || /[\\/]/.test(name)) {
    throw new DuelError(DUEL_ERROR_CODES.deliverableFailed, `交付物文件名非法：${JSON.stringify(name)}`)
  }
}
