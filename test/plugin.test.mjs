import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  Config,
  DUEL_ERROR_CODES,
  DuelError,
  apply,
  chooseReviewerProvider,
  resolveConfig,
  resolveProvider,
  runDuel,
  validateDeployment,
} from '../dist/index.js'

const execFileAsync = promisify(execFile)

test('插件装配：注册两个工具并贡献系统提示词', () => {
  const registered = []
  const sections = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    systemPrompt: { section: (section) => sections.push(section) },
    get: () => undefined,
  }
  apply(ctx, Config({}))
  assert.deepEqual(registered.map((definition) => definition.name).sort(), ['duel_review', 'duel_run'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:duel')
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.isConcurrencySafe?.({}), false)
  }
})

test('schema 归一化后的空数组仍落到文档默认值', () => {
  const resolved = resolveConfig(Config({}))
  assert.deepEqual(resolved.blockOn, ['P0', 'P1'])
  assert.equal(resolved.maxRounds, 3)
  assert.equal(resolved.escalate, 'human')
  assert.deepEqual(resolved.deliverables, ['delivery-package', 'review-report', 'response-table'])
  assert.equal(resolved.subagentProvider, 'spawn')
  assert.equal(resolved.reviewer.isolation, true)
})

test('schema 默认值：最小配置只给 writer.model', () => {
  const resolved = resolveConfig(Config({ writer: { model: 'glm-4.7' } }))
  assert.deepEqual(resolved.writer.route, { model: 'glm-4.7' })
  assert.deepEqual(resolved.reviewer.route, {})
})

test('隔离硬约束：isolation=true 时 fork 后端被拒绝', () => {
  assert.throws(
    () => validateDeployment(resolveConfig({ subagentProvider: 'fork', reviewer: { isolation: true } })),
    (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.invalidConfig,
  )
  assert.doesNotThrow(() => validateDeployment(resolveConfig({ subagentProvider: 'fork', reviewer: { isolation: false } })))
})

test('对抗性软提示：writer 与 reviewer 完全同路由时给出告警', () => {
  const config = resolveConfig({
    writer: { provider: 'p', model: 'm' },
    reviewer: { provider: 'p', model: 'm' },
  })
  const warnings = validateDeployment(config)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /使用同一模型/)

  const heterogeneous = resolveConfig({
    writer: { provider: 'p', model: 'glm-4.7' },
    reviewer: { provider: 'p', model: 'deepseek-chat' },
  })
  assert.deepEqual(validateDeployment(heterogeneous), [])
})

test('隔离回退：只注册 fork 时审核者也绝不回退到 fork', () => {
  const ctxOnlyFork = {
    get: (name) => (name === 'subagents' ? { getProvider: (provider) => (provider === 'fork' ? {} : undefined) } : undefined),
  }
  const isolated = resolveConfig({ reviewer: { isolation: true }, subagentProvider: 'spawn' })
  assert.equal(chooseReviewerProvider(ctxOnlyFork, isolated), 'spawn')

  const both = {
    get: (name) =>
      name === 'subagents'
        ? { getProvider: (provider) => (provider === 'spawn' || provider === 'fork' ? {} : undefined) }
        : undefined,
  }
  const shared = resolveConfig({ reviewer: { isolation: false } })
  assert.equal(chooseReviewerProvider(both, shared), 'fork')
})

test('隔离关闭时审核提示词不再宣称看不到编写历史', async () => {
  const { reviewerSystemPrompt } = await import('../dist/index.js')
  assert.match(reviewerSystemPrompt(true), /你只会看到需求/)
  assert.doesNotMatch(reviewerSystemPrompt(false), /你只会看到需求/)
  assert.match(reviewerSystemPrompt(false), /未启用上下文隔离/)
})

test('后端回退：配置的后端不存在时退回已注册后端', () => {
  const ctx = { get: (name) => (name === 'subagents' ? { getProvider: (provider) => (provider === 'fork' ? {} : undefined) } : undefined) }
  assert.equal(resolveProvider(ctx, 'spawn'), 'fork')
  assert.equal(resolveProvider(ctx, 'fork'), 'fork')
  const noQuery = { get: (name) => (name === 'subagents' ? {} : undefined) }
  assert.equal(resolveProvider(noQuery, 'spawn'), 'spawn')
})

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-duel-plugin-'))
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'hello\n')
  await execFileAsync('git', ['add', '-A'], { cwd: dir })
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

function fakeAgent(cwd) {
  return { session: { meta: { cwd } } }
}

function fakeCtx(steps) {
  return {
    get: (name) =>
      name === 'subagents'
        ? {
            async startActivation(spec) {
              const step = steps.shift()
              assert.ok(step, 'fake subagent 收到多余的调用')
              const output = await step(spec)
              return {
                childId: 'c-' + Math.floor(Math.random() * 1e6),
                result: Promise.resolve({ output: [{ type: 'text', text: output }], stopReason: 'completed' }),
                async dispose() {},
              }
            },
          }
        : undefined,
  }
}

test('编写者没有产生 diff → DUEL_NO_CHANGES（不进入审核）', async () => {
  const repo = await makeRepo()
  try {
    const steps = [
      async () => '我改了（其实没改）。\n```json\n{"selfTests":[],"changeSummary":{},"responses":[]}\n```',
    ]
    const config = resolveConfig({ gate: { maxRounds: 1 } })
    await assert.rejects(
      () =>
        runDuel(fakeCtx(steps), config, {
          requirement: '改点什么',
          agent: fakeAgent(repo),
          signal: new AbortController().signal,
        }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.noChanges,
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('审核者改动工作区 → 审核报告不可信，升级人工而不是放行', async () => {
  const repo = await makeRepo()
  try {
    const review = `# 审核报告（第 1 轮）\n\n## 三、问题清单\n| 编号 | 级别 | 问题 | 复现方式 | 建议 |\n|---|---|---|---|---|\n| — | — | 无 | — | — |\n\n\`\`\`json\n{"verdict":"pass","issues":[]}\n\`\`\``
    const steps = [
      async () => {
        await writeFile(join(repo, 'a.txt'), 'writer v1\n')
        return '```json\n{"selfTests":[],"changeSummary":{},"responses":[]}\n```'
      },
      async () => {
        await writeFile(join(repo, 'a.txt'), 'reviewer modified this\n')
        return review
      },
    ]
    const config = resolveConfig({ gate: { maxRounds: 1 } })
    const result = await runDuel(fakeCtx(steps), config, {
      requirement: 'x',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'escalated')
    assert.match(result.summary, /审核者改动了工作区/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('编写者零改动但工作区本来就有脏改动 → 仍判 DUEL_NO_CHANGES', async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo, 'a.txt'), 'pre-existing user change\n')
    const steps = [
      async () => '我什么也没改。\n```json\n{"selfTests":[],"changeSummary":{},"responses":[]}\n```',
    ]
    const config = resolveConfig({ gate: { maxRounds: 1 } })
    await assert.rejects(
      () =>
        runDuel(fakeCtx(steps), config, {
          requirement: '改点什么',
          agent: fakeAgent(repo),
          signal: new AbortController().signal,
        }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.noChanges,
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('打回后编写者未逐项响应 → 响应表如实记录缺失编号', async () => {
  const repo = await makeRepo()
  try {
    const p0 = { id: 'P0-1', severity: 'P0', problem: '残留', reproduce: 'grep', suggestion: '修掉' }
    const review = (verdict, issues) =>
      `# 审核报告（第 1 轮）\n\n## 三、问题清单\n| 编号 | 级别 | 问题 | 复现方式 | 建议 |\n|---|---|---|---|---|\n${
        issues.length === 0
          ? '| — | — | 无 | — | — |'
          : issues.map((issue) => `| ${issue.id} | ${issue.severity} | ${issue.problem} | ${issue.reproduce} | ${issue.suggestion} |`).join('\n')
      }\n\n\`\`\`json\n${JSON.stringify({ verdict, issues, residual: [] })}\n\`\`\``
    const steps = [
      async () => {
        await writeFile(join(repo, 'a.txt'), 'v1\n')
        return '```json\n{"selfTests":[],"changeSummary":{},"responses":[]}\n```'
      },
      async () => review('reject', [p0]),
      async () => {
        await writeFile(join(repo, 'a.txt'), 'v2\n')
        return '我没空逐项回应。\n```json\n{"selfTests":[],"changeSummary":{},"responses":[]}\n```'
      },
      async () => review('pass', []),
    ]
    const config = resolveConfig({ gate: { maxRounds: 2 } })
    const result = await runDuel(fakeCtx(steps), config, {
      requirement: '修 bug',
      agent: fakeAgent(repo),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'passed')
    const table = await readFile(join(result.runDir, 'response-table-1.md'), 'utf8')
    assert.match(table, /未提交逐项响应/)
    assert.match(table, /P0-1/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
