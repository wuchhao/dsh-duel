/**
 * 工作区变更捕获：把编写子代理在 git 工作树里的改动整理成审核者能直接读的
 * diff 与变更文件清单。评审的独立性要求审核者只看 diff，所以这里必须覆盖
 * 已跟踪文件的暂存/未暂存改动，以及尚未 `git add` 的新文件内容。
 *
 * 所有 git 查询都从仓库根执行：会话 cwd 可能是仓库子目录，而 diff 与未跟踪
 * 文件清单必须覆盖整个仓库，否则审核者会漏看 cwd 之外的新文件。
 * @module dsh-duel/diff
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DUEL_ERROR_CODES, DuelError } from './errors.js'
import type { ChangeSet, FileChange } from './types.js'

/** 单个未跟踪文件最多收录的字符数。 */
export const MAX_UNTRACKED_FILE_CHARS = 64 * 1024

/** 最多收录的未跟踪文件个数。 */
export const MAX_UNTRACKED_FILES = 20

/** 一次 git 调用的结果。 */
interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** 捕获变更的选项。 */
export interface CaptureOptions {
  /** 工作目录（子代理的 cwd）。 */
  readonly cwd: string
  /** diff 字符上限。 */
  readonly maxDiffChars: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
  /** 未跟踪文件内容收录上限（测试可注入）。 */
  readonly maxUntrackedFiles?: number
  /** 单文件字符上限（测试可注入）。 */
  readonly maxUntrackedFileChars?: number
  /** 需要排除的仓库相对目录（如插件自己的交付物目录），避免自身产物污染 diff。 */
  readonly exclude?: readonly string[]
}

/**
 * 执行一条 git 命令。非零退出码不抛错，由调用方决定是否接受。
 * @param cwd - 工作目录（始终传仓库根，保证路径是仓库相对路径）。
 * @param args - git 参数。
 * @param signal - 取消信号。
 * @returns 标准输出、标准错误与退出码。
 * @throws {DuelError} git 不可用时 code 为 `DUEL_GIT_UNAVAILABLE`。
 */
async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(signal === undefined ? {} : { signal }) },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            reject(new DuelError(DUEL_ERROR_CODES.gitUnavailable, '找不到 git 可执行文件；dsh-duel 需要 git 工作树来捕获 diff'))
            return
          }
          if (typeof code === 'number') {
            resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code })
            return
          }
          reject(error)
          return
        }
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 })
      },
    )
  })
}

/** 解析 `git rev-parse --show-toplevel`。 */
async function resolveRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], signal)
  const root = result.stdout.trim()
  if (result.code !== 0 || root.length === 0) {
    throw new DuelError(
      DUEL_ERROR_CODES.notARepo,
      `工作目录不是 git 工作树，无法捕获 diff：${cwd}`,
    )
  }
  return root
}

/** 判断仓库是否已有 HEAD 提交。 */
async function hasHead(repoRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal)
  return result.code === 0
}

/** 按行解析 `git diff --numstat`（禁用重命名后路径是单一真实路径）。 */
function parseNumstat(text: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const rawAdd = parts[0] ?? ''
    const rawDel = parts[1] ?? ''
    const path = parts.slice(2).join('\t').trim()
    if (path.length === 0 || path.includes(' => ')) continue
    counts.set(path, {
      additions: rawAdd === '-' ? 0 : Number.parseInt(rawAdd, 10) || 0,
      deletions: rawDel === '-' ? 0 : Number.parseInt(rawDel, 10) || 0,
    })
  }
  return counts
}

/** 从 diff 文本的文件段头判断每个文件的变更状态（删除侧用 `--- a/path` 还原路径）。 */
function parseStatuses(text: string): Map<string, FileChange['status']> {
  const statuses = new Map<string, FileChange['status']>()
  let current: 'added' | 'modified' | 'deleted' | undefined
  let oldPath: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      oldPath = undefined
      continue
    }
    if (line.startsWith('--- a/') || line === '--- /dev/null') {
      const old = line.slice(4).trim()
      oldPath = old === '/dev/null' ? undefined : old.replace(/^a\//, '')
      if (old === '/dev/null') current = 'added'
      else if (current === undefined) current = 'modified'
      continue
    }
    if (line.startsWith('+++ b/') || line === '+++ /dev/null') {
      const newRaw = line.slice(4).trim()
      if (newRaw === '/dev/null') {
        current = 'deleted'
        if (oldPath !== undefined) statuses.set(oldPath, 'deleted')
        continue
      }
      const path = newRaw.replace(/^b\//, '')
      if (path.length > 0) statuses.set(path, current ?? 'modified')
      continue
    }
  }
  return statuses
}

/** 构造未跟踪文件的合成 diff 段。 */
function synthesizeNewFile(path: string, content: string, truncated: boolean, maxChars: number): string {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((line) => '+' + line).join('\n')
  const note = truncated ? `\n+... [文件内容超过 ${maxChars} 字符，已截断]` : ''
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body + note,
  ].join('\n')
}

/**
 * 捕获工作区当前变更。
 * @param options - 工作目录、上限与取消信号。
 * @returns 仓库根、diff、是否截断、变更文件清单。
 * @throws {DuelError} 不是 git 工作树或 git 不可用。
 */
export async function captureChanges(options: CaptureOptions): Promise<ChangeSet> {
  const cwd = resolve(options.cwd)
  const repoRoot = await resolveRepoRoot(cwd, options.signal)
  const withHead = await hasHead(repoRoot, options.signal)

  // 插件自己的交付物目录必须排除，否则每轮写盘都会被当成「审核者改了工作区」。
  // 只用排除型 pathspec（不附加 `.`），这样无论会话 cwd 是仓库根还是子目录，
  // git 都按仓库根解析 `:(top,exclude)`，不会意外把 diff 限制在子目录内。
  const excludes = (options.exclude ?? [])
    .map((dir) => dir.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter((dir) => dir.length > 0)
  const pathspec = excludes.length === 0 ? [] : ['--', ...excludes.map((dir) => `:(top,exclude)${dir}/**`)]
  const common = ['--no-color', '--no-ext-diff', '--no-renames']

  const diffArgs = withHead
    ? [['diff', ...common, 'HEAD', ...pathspec]]
    : [
        ['diff', ...common, '--cached', ...pathspec],
        ['diff', ...common, ...pathspec],
      ]
  const numstatArgs = withHead
    ? [['diff', '--numstat', '--no-renames', 'HEAD', ...pathspec]]
    : [
        ['diff', '--numstat', '--no-renames', '--cached', ...pathspec],
        ['diff', '--numstat', '--no-renames', ...pathspec],
      ]

  const diffChunks: string[] = []
  for (const args of diffArgs) {
    const result = await runGit(repoRoot, args, options.signal)
    if (result.code === 0 && result.stdout.trim().length > 0) diffChunks.push(result.stdout)
  }
  const numstatChunks: string[] = []
  for (const args of numstatArgs) {
    const result = await runGit(repoRoot, args, options.signal)
    if (result.code === 0 && result.stdout.trim().length > 0) numstatChunks.push(result.stdout)
  }

  // 从仓库根执行，输出即仓库相对路径；--full-name 明确请求完整路径。
  const untrackedResult = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '--full-name'], options.signal)
  const untracked = untrackedResult.code === 0
    ? untrackedResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !excludes.some((dir) => line === dir || line.startsWith(dir + '/')))
    : []

  const baseDiff = diffChunks.join('\n')
  const counts = parseNumstat(numstatChunks.join('\n'))
  const statuses = parseStatuses(baseDiff)

  const files: FileChange[] = []
  for (const [path, count] of counts) {
    const status = statuses.get(path) ?? 'modified'
    files.push({ path, status, additions: count.additions, deletions: count.deletions, summary: '' })
  }

  const maxFiles = options.maxUntrackedFiles ?? MAX_UNTRACKED_FILES
  const maxChars = options.maxUntrackedFileChars ?? MAX_UNTRACKED_FILE_CHARS
  const collected = untracked.slice(0, maxFiles)
  const omitted = untracked.length - collected.length
  const synthetic: string[] = []
  for (const path of collected) {
    let content: string
    try {
      const raw = await readFile(resolve(repoRoot, path))
      if (raw.includes(0)) {
        synthetic.push(`diff --git a/${path} b/${path}\nnew file mode 100644\n（二进制文件，内容未收录）`)
        files.push({ path, status: 'untracked', additions: 0, deletions: 0, summary: '二进制文件' })
        continue
      }
      const text = raw.toString('utf8')
      const truncated = text.length > maxChars
      content = truncated ? text.slice(0, maxChars) : text
      synthetic.push(synthesizeNewFile(path, content, truncated, maxChars))
      files.push({
        path,
        status: 'untracked',
        additions: content.split('\n').length,
        deletions: 0,
        summary: '',
      })
    } catch {
      synthetic.push(`diff --git a/${path} b/${path}\nnew file mode 100644\n（文件不可读，内容未收录）`)
      files.push({ path, status: 'untracked', additions: 0, deletions: 0, summary: '不可读' })
    }
  }
  if (omitted > 0) {
    synthetic.push(`... [另有 ${omitted} 个未跟踪文件未收录：超过 ${maxFiles} 个文件上限]`)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  const joined = [baseDiff, ...synthetic].filter((chunk) => chunk.trim().length > 0).join('\n')
  const truncated = joined.length > options.maxDiffChars || omitted > 0
  const diff = truncated && joined.length > options.maxDiffChars
    ? joined.slice(0, options.maxDiffChars) + '\n... [diff 已截断]'
    : joined

  return { repoRoot, cwd, diff, truncated, files }
}

/**
 * 从 diff 文本推导变更文件清单（用于 `duel_review` 直接传入 diff 的场景）。
 * 覆盖新增 / 修改 / 删除三类；删除文件没有 `+++` 行，路径从 `--- a/path` 还原。
 * @param diff - 统一 diff 文本。
 * @returns 文件清单（同路径多段会合并计数）。
 */
export function filesFromDiff(diff: string): FileChange[] {
  const collected = new Map<string, { status: FileChange['status']; additions: number; deletions: number }>()
  let oldPath: string | undefined
  let newPath: string | undefined
  let additions = 0
  let deletions = 0

  const flush = (): void => {
    const path = newPath ?? oldPath
    if (path !== undefined) {
      const status: FileChange['status'] = newPath === undefined ? 'deleted' : oldPath === undefined ? 'added' : 'modified'
      const previous = collected.get(path)
      collected.set(path, {
        status: previous?.status === 'added' || status === 'added' ? 'added' : status,
        additions: (previous?.additions ?? 0) + additions,
        deletions: (previous?.deletions ?? 0) + deletions,
      })
    }
    oldPath = undefined
    newPath = undefined
    additions = 0
    deletions = 0
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      continue
    }
    if (line.startsWith('--- a/') || line === '--- /dev/null') {
      const candidate = line.slice(4).trim()
      oldPath = candidate === '/dev/null' ? undefined : candidate.replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ b/') || line === '+++ /dev/null') {
      const candidate = line.slice(4).trim()
      newPath = candidate === '/dev/null' ? undefined : candidate.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('+')) {
      additions += 1
      continue
    }
    if (line.startsWith('-')) {
      deletions += 1
    }
  }
  flush()

  return [...collected.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, value]) => ({
      path,
      status: value.status,
      additions: value.additions,
      deletions: value.deletions,
      summary: '',
    }))
}
