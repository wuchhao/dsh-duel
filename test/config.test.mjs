import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BLOCK_ON,
  DEFAULT_MAX_ROUNDS,
  DUEL_ERROR_CODES,
  DuelError,
  formatModelRoute,
  resolveConfig,
} from '../dist/index.js'

test('空配置落到文档默认值', () => {
  const config = resolveConfig({})
  assert.deepEqual(config.blockOn, [...DEFAULT_BLOCK_ON])
  assert.equal(config.maxRounds, DEFAULT_MAX_ROUNDS)
  assert.equal(config.escalate, 'human')
  assert.equal(config.subagentProvider, 'spawn')
  assert.equal(config.deliverableDir, '.dsh-duel')
  assert.equal(config.reviewer.isolation, true)
  assert.deepEqual(config.deliverables, ['delivery-package', 'review-report', 'response-table'])
  assert.equal(config.timeoutMs, undefined)
})

test('只有 model 时继承父代理 provider', () => {
  const config = resolveConfig({ writer: { model: 'glm-4.7' }, reviewer: { model: 'deepseek-chat' } })
  assert.deepEqual(config.writer.route, { model: 'glm-4.7' })
  assert.equal(formatModelRoute(config.writer.route), 'inherit/glm-4.7')
  assert.deepEqual(config.reviewer.route, { model: 'deepseek-chat' })
})

test('显式 provider/model/maxTokens 原样保留', () => {
  const config = resolveConfig({ writer: { provider: 'p', model: 'm', maxTokens: 4096 } })
  assert.deepEqual(config.writer.route, { provider: 'p', model: 'm', maxTokens: 4096 })
})

test('blockOn 校验：非法级别 / 空数组落到默认值 / 大小写归一', () => {
  assert.throws(
    () => resolveConfig({ gate: { blockOn: ['P9'] } }),
    (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.invalidConfig,
  )
  assert.deepEqual(resolveConfig({ gate: { blockOn: [] } }).blockOn, [...DEFAULT_BLOCK_ON])
  assert.deepEqual(resolveConfig({ gate: { blockOn: ['p0', 'P1'] } }).blockOn, ['P0', 'P1'])
})

test('deliverables 校验：非法种类与去重', () => {
  assert.throws(() => resolveConfig({ deliverables: ['nope'] }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.deepEqual(resolveConfig({ deliverables: ['review-report', 'review-report'] }).deliverables, ['review-report'])
})

test('maxRounds 与 timeoutMs 必须是合法正整数', () => {
  assert.throws(() => resolveConfig({ gate: { maxRounds: 0 } }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.throws(() => resolveConfig({ gate: { maxRounds: 11 } }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.throws(() => resolveConfig({ gate: { maxRounds: 1.5 } }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.throws(() => resolveConfig({ timeoutMs: -1 }), { code: DUEL_ERROR_CODES.invalidConfig })
})

test('escalate 校验', () => {
  assert.equal(resolveConfig({ gate: { escalate: 'stop' } }).escalate, 'stop')
  assert.throws(() => resolveConfig({ gate: { escalate: 'human-please' } }), { code: DUEL_ERROR_CODES.invalidConfig })
})

test('deliverableDir 禁止绝对路径与路径穿越', () => {
  assert.throws(() => resolveConfig({ deliverableDir: '..\\secret' }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.throws(() => resolveConfig({ deliverableDir: 'C:\\tmp' }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.throws(() => resolveConfig({ deliverableDir: '/tmp' }), { code: DUEL_ERROR_CODES.invalidConfig })
  assert.equal(resolveConfig({ deliverableDir: 'reports\\duel' }).deliverableDir, 'reports/duel')
})

test('deliverableDir 禁止 UNC / 盘符相对 / 根相对写法', () => {
  for (const bad of ['\\\\escaping', '\\\\server\\share\\leak', 'C:relative', '\\rooted', 'a/../../b', '../x']) {
    assert.throws(
      () => resolveConfig({ deliverableDir: bad }),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.invalidConfig,
      `deliverableDir=${JSON.stringify(bad)} 应被拒绝`,
    )
  }
})
