import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  DUEL_ERROR_CODES,
  DuelError,
  captureChanges,
  filesFromDiff,
  resolveConfig,
  runChild,
  runDuel,
  runReview,
} from '../dist/index.js'

const execFileAsync = promisify(execFile)

async function git(cwd, ...args) {
  return execFileAsync('git', ['-c', 'user.name=duel-test', '-c', 'user.email=duel@test', ...args], { cwd })
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-duel-'))
  await git(dir, 'init', '-q')
  await writeFile(join(dir, 'a.txt'), 'hello\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function fakeAgent(cwd) {
  return { session: { meta: { cwd } } }
}

/** 伪造 subagents 服务：按 startActivation 新版入口。 */
function fakeSubagentsNew(steps, onDispose = async () => {}) {
  return {
    async startActivation(spec) {
      const text = spec.prompt?.[0]?.text ?? ''
      const role = text.includes('编写模型（Writer）') ? 'writer' : 'reviewer'
      const step = steps.shift()
      assert.ok(step, 'fake subagent 收到多余的调用')
      const output = await step({ role, spec })
      return {
        childId: 'child-' + Math.floor(Math.random() * 1e6),
        result: Promise.resolve({ output: [{ type: 'text', text: output }], stopReason: 'completed' }),
        async dispose() {
          await onDispose()
        },
      }
    },
  }
}

/** 伪造 subagents 服务：仅提供早期 `start(provider, request)` 入口。 */
function fakeSubagentsLegacy(steps) {
  return {
    async start(provider, request) {
      const text = request.prompt?.[0]?.text ?? ''
      const role = text.includes('编写模型（Writer）') ? 'writer' : 'reviewer'
      const step = steps.shift()
      assert.ok(step, 'fake subagent 收到多余的调用')
      const output = await step({ role, spec: request, provider })
      return {
        id: 'legacy-' + Math.floor(Math.random() * 1e6),
        result: Promise.resolve({ output: [{ type: 'text', text: output }], stopReason: 'completed' }),
        async dispose() {},
      }
    },
  }
}

function fakeCtx(service) {
  return { get: (name) => (name === 'subagents' ? service : undefined) }
}

const writerJson = (responses) => `已完成。

\`\`\`json
${JSON.stringify({ selfTests: ['node --test'], changeSummary: { 'a.txt': '补充内容' }, responses }, null, 2)}
\`\`\``

const reviewJson = (verdict, issues) => `# 改造 审核报告（第 1 轮）

## 一、结论
${verdict === 'pass' ? '可上线' : '打回'}

## 二、逐项核验
我实测了 stub。

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
${issues.length === 0 ? '| — | — | 无 | — | — |' : issues.map((issue) => `| ${issue.id} | ${issue.severity} | ${issue.problem} | ${issue.reproduce} | ${issue.suggestion} |`).join('\n')}

## 四、遗留项
无

\`\`\`json
${JSON.stringify({ verdict, issues, residual: [] }, null, 2)}
\`\`\``

const p0 = { id: 'P0-1', severity: 'P0', problem: '残留改名', reproduce: 'grep', suggestion: '修掉' }

test('diff 捕获：已跟踪改动 + 未跟踪文件内容', async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo, 'a.txt'), 'hello world\n')
    await writeFile(join(repo, 'b.txt'), 'brand new\n')
    const changes = await captureChanges({ cwd: repo, maxDiffChars: 100_000 })
    assert.ok(changes.files.some((file) => file.path === 'a.txt' && file.status === 'modified'))
    assert.ok(changes.files.some((file) => file.path === 'b.txt' && file.status === 'untracked'))
    assert.match(changes.diff, /\+hello world/)
    assert.match(changes.diff, /\+brand new/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('diff 捕获：超上限截断并标记', async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo, 'a.txt'), Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const changes = await captureChanges({ cwd: repo, maxDiffChars: 200 })
    assert.equal(changes.truncated, true)
    assert.match(changes.diff, /diff 已截断/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('非 git 目录 → DUEL_NOT_A_REPO', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-duel-norepo-'))
  try {
    await assert.rejects(
      () => captureChanges({ cwd: dir, maxDiffChars: 10_000 }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.notARepo,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：打回一轮后 P0 清零 → passed，交付物齐全', async () => {
  const repo = await makeRepo()
  try {
    const steps = [
      async ({ role }) => {
        assert.equal(role, 'writer')
        await writeFile(join(repo, 'a.txt'), 'hello v1\n')
        return writerJson([])
      },
      async ({ role }) => {
        assert.equal(role, 'reviewer')
        return reviewJson('reject', [p0])
      },
      async ({ role }) => {
        assert.equal(role, 'writer')
        await writeFile(join(repo, 'a.txt'), 'hello v2\n')
        return writerJson([{ id: 'P0-1', action: '已修复', changes: '改名完成', verification: 'grep 无残留' }])
      },
      async ({ role }) => {
        assert.equal(role, 'reviewer')
        return reviewJson('pass', [])
      },
    ]
    const config = resolveConfig({ gate: { maxRounds: 2 }, deliverables: ['delivery-package', 'review-report', 'response-table'] })
    const result = await runDuel(fakeCtx(fakeSubagentsNew(steps)), config, {
      requirement: '修掉残留改名',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })

    assert.equal(result.status, 'passed')
    assert.equal(result.rounds, 2)
    assert.equal(result.blocking.length, 0)
    assert.ok(result.runDir, '应写出交付物目录')
    for (const name of [
      'delivery-package-1.md',
      'review-report-1.md',
      'delivery-package-2.md',
      'review-report-2.md',
      'response-table-1.md',
      'manifest.json',
    ]) {
      assert.ok(result.files.includes(name), `缺少交付物 ${name}`)
    }
    const responseTable = await readFile(join(result.runDir, 'response-table-1.md'), 'utf8')
    assert.match(responseTable, /已修复/)
    const manifest = JSON.parse(await readFile(join(result.runDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'passed')
    assert.equal(manifest.rounds, 2)
    assert.equal(manifest.reviewerMutated, false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('端到端：达到 maxRounds 仍 P0 未清 → escalated', async () => {
  const repo = await makeRepo()
  try {
    const steps = [
      async () => {
        await writeFile(join(repo, 'a.txt'), 'x\n')
        return writerJson([])
      },
      async () => reviewJson('reject', [p0]),
    ]
    const config = resolveConfig({ gate: { maxRounds: 1 } })
    const result = await runDuel(fakeCtx(fakeSubagentsNew(steps)), config, {
      requirement: '修 bug',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'escalated')
    assert.equal(result.rounds, 1)
    assert.deepEqual(result.blocking.map((issue) => issue.id), ['P0-1'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('兼容早期 subagents.start(provider, request) 入口', async () => {
  const repo = await makeRepo()
  try {
    const steps = [
      async () => {
        await writeFile(join(repo, 'a.txt'), 'y\n')
        return writerJson([])
      },
      async () => reviewJson('pass', []),
    ]
    const config = resolveConfig({ gate: { maxRounds: 1 }, deliverables: ['review-report'] })
    const result = await runDuel(fakeCtx(fakeSubagentsLegacy(steps)), config, {
      requirement: '只验证兼容层',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'passed')
    assert.equal(result.files.includes('delivery-package-1.md'), false, '未启用的交付物不应写出')
    assert.ok(result.files.includes('review-report-1.md'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('duel_review：只审核给定 diff，不改代码', async () => {
  const repo = await makeRepo()
  try {
    const steps = [async () => reviewJson('reject', [p0])]
    const config = resolveConfig({})
    const result = await runReview(fakeCtx(fakeSubagentsNew(steps)), config, {
      requirement: '审查外部 diff',
      diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n+new\n',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'rejected')
    assert.deepEqual(result.blocking.map((issue) => issue.id), ['P0-1'])
    assert.ok(result.files.includes('delivery-package-1.md'))
    assert.ok(result.files.includes('review-report-1.md'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('diff 捕获：会话 cwd 在仓库子目录时仍覆盖全仓未跟踪文件', async () => {
  const repo = await makeRepo()
  try {
    await mkdir(join(repo, 'sub'), { recursive: true })
    await writeFile(join(repo, 'root-new.txt'), 'root new\n')
    await writeFile(join(repo, 'sub', 'sub-new.txt'), 'sub new\n')
    const changes = await captureChanges({ cwd: join(repo, 'sub'), maxDiffChars: 100_000 })
    const paths = changes.files.map((file) => file.path)
    assert.ok(paths.includes('root-new.txt'), '仓库根的新文件必须被采集')
    assert.ok(paths.includes('sub/sub-new.txt'), '子目录新文件路径必须是仓库相对路径')
    assert.match(changes.diff, /\+root new/)
    assert.match(changes.diff, /\+sub new/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('diff 捕获：未跟踪文件超上限时标记 truncated 并写明未收录数量', async () => {
  const repo = await makeRepo()
  try {
    for (let i = 0; i < 3; i++) await writeFile(join(repo, `new-${i}.txt`), `file ${i}\n`)
    const changes = await captureChanges({ cwd: repo, maxDiffChars: 100_000, maxUntrackedFiles: 1 })
    assert.equal(changes.truncated, true)
    assert.match(changes.diff, /另有 2 个未跟踪文件未收录/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('diff 捕获：重命名不产生 "old => new" 错误路径', async () => {
  const repo = await makeRepo()
  try {
    await git(repo, 'mv', 'a.txt', 'renamed.txt')
    const changes = await captureChanges({ cwd: repo, maxDiffChars: 100_000 })
    for (const file of changes.files) {
      assert.doesNotMatch(file.path, /=>/, `files 中出现重命名标记：${file.path}`)
    }
    const paths = changes.files.map((file) => file.path)
    assert.ok(paths.includes('a.txt'))
    assert.ok(paths.includes('renamed.txt'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('runChild：provider 结果永不 settle 时按 timeoutMs 硬失败', async () => {
  const repo = await makeRepo()
  try {
    const service = {
      async startActivation() {
        return { childId: 'x', result: new Promise(() => {}), async dispose() {} }
      },
    }
    const started = Date.now()
    await assert.rejects(
      () =>
        runChild(fakeCtx(service), {
          provider: 'spawn',
          label: 'duel-writer-1',
          prompt: 'p',
          route: {},
          parent: fakeAgent(repo),
          signal: new AbortController().signal,
          timeoutMs: 120,
        }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.childFailed,
    )
    assert.ok(Date.now() - started < 2000, '超时应快速失败，不能等 provider settle')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('diff 捕获：删除文件标注 deleted 且带删除行数', async () => {
  const repo = await makeRepo()
  try {
    await git(repo, 'rm', '-q', 'a.txt')
    const changes = await captureChanges({ cwd: repo, maxDiffChars: 100_000 })
    const deleted = changes.files.find((file) => file.path === 'a.txt')
    assert.ok(deleted, '删除文件必须出现在清单里')
    assert.equal(deleted.status, 'deleted')
    assert.ok(deleted.deletions >= 1)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('filesFromDiff：显式 diff 解析删除文件与增删行数', () => {
  const diff = [
    'diff --git a/mod.ts b/mod.ts',
    '--- a/mod.ts',
    '+++ b/mod.ts',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+added',
    'diff --git a/del.ts b/del.ts',
    'deleted file mode 100644',
    '--- a/del.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n')
  const files = filesFromDiff(diff)
  const mod = files.find((file) => file.path === 'mod.ts')
  const del = files.find((file) => file.path === 'del.ts')
  assert.equal(mod.status, 'modified')
  assert.equal(mod.additions, 2)
  assert.equal(mod.deletions, 1)
  assert.equal(del.status, 'deleted')
  assert.equal(del.deletions, 1)
})

test('取消信号：runChild 抛 AbortError', async () => {
  const repo = await makeRepo()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () =>
        runChild(fakeCtx(fakeSubagentsNew([])), {
          provider: 'spawn',
          label: 'duel-writer-1',
          prompt: 'p',
          route: {},
          parent: fakeAgent(repo),
          signal: controller.signal,
        }),
      { name: 'AbortError' },
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('子代理失败（stopReason=error）→ DUEL_CHILD_FAILED', async () => {
  const repo = await makeRepo()
  try {
    const service = {
      async startActivation() {
        return {
          childId: 'x',
          result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: '模型断流' }),
          async dispose() {},
        }
      },
    }
    await assert.rejects(
      () =>
        runChild(fakeCtx(service), {
          provider: 'spawn',
          label: 'duel-reviewer-1',
          prompt: 'p',
          route: {},
          parent: fakeAgent(repo),
          signal: new AbortController().signal,
        }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.childFailed,
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
