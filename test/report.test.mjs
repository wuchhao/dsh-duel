import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DUEL_ERROR_CODES,
  DuelError,
  buildDeliveryPackageMarkdown,
  evaluateGate,
  extractStructuredResult,
  normalizeSeverity,
  parseReviewReport,
  parseWriterReport,
  renderResponseTable,
  renderReviewReportFile,
} from '../dist/index.js'

const META = { writerModel: 'inherit/glm-4.7', reviewerModel: 'inherit/deepseek-chat' }

function reviewerJson(verdict, issues) {
  return `# 改造 审核报告（第 1 轮）

## 一、结论
${verdict === 'pass' ? '可上线' : '打回（P0-1）'}

## 二、逐项核验
我实跑了 stub，最坏耗时 12.06s。

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| — | — | 无 | — | — |

## 四、遗留项
无

\`\`\`json
${JSON.stringify({ verdict, issues, residual: [] }, null, 2)}
\`\`\``
}

test('JSON issues 形状非法（字符串/null/对象/字符串数组）→ fail-closed', () => {
  for (const issues of ['P0-1: 静默失效', null, { 'P0-1': 'x' }, ['P0-1: 静默失效']]) {
    assert.throws(
      () => parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict: 'pass', issues })}\n\`\`\``, 1),
      (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.reviewUnparseable,
      `issues=${JSON.stringify(issues)} 应 fail-closed`,
    )
  }
})

test('报告回退模板不留占位符', () => {
  const report = parseReviewReport('## 一、结论\n可上线\n\n```json\n{"verdict":"pass","issues":[]}\n```', 1)
  const file = renderReviewReportFile(report, { writerModel: 'a', reviewerModel: 'b' })
  assert.doesNotMatch(file, /<改造名>|<N>|<可上线/)
  assert.match(file, /可上线|pass/)
})

test('对冲/未决的肯定措辞也必须 fail-closed', () => {
  for (const verdict of [
    '可能通过',
    '也许通过',
    '大概率通过',
    '尚需确认是否通过',
    '需确认是否通过',
    '请人工确认是否通过',
    '需人工判断是否通过',
    '通过与否需确认',
    '是否通过需确认',
    '基本通过',
    '有条件通过',
    '部分通过',
  ]) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  }
})

test('JSON 缺 verdict 时读正文结论，不被空 issues 放行', () => {
  const rejected = parseReviewReport('## 一、结论\n打回\n\n## 二、逐项核验\n无\n\n```json\n{"issues":[]}\n```', 1)
  assert.equal(rejected.verdict, 'reject')
  assert.equal(evaluateGate(rejected, ['P0', 'P1']).blocked, true)

  const passed = parseReviewReport('## 一、结论\n可上线\n\n```json\n{"issues":[]}\n```', 1)
  assert.equal(passed.verdict, 'pass')
})

test('带附加说明的肯定结论仍识别为 pass', () => {
  for (const verdict of ['pass（P0/P1 已清零）', 'pass, no P0/P1', 'approved (no blocking issues)']) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'pass')
  }
})

test('JSON 只列 P2、正文列 P0 时，正文 P0 仍进入门禁', () => {
  const text = `# 审核报告

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| P0-7 | P0 | 正文的静默失效 | 无 | 无 |
| P2-1 | P2 | JSON 里也有 | 无 | 无 |

\`\`\`json
{"verdict":"pass","issues":[{"id":"P2-1","severity":"P2","problem":"x","reproduce":"r","suggestion":"s"}]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.ok(report.issues.some((issue) => issue.id === 'P0-7' && issue.severity === 'P0'))
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
})

test('只有正文结论、没有 JSON/问题表时也能解析', () => {
  const report = parseReviewReport('# 审核报告\n\n## 一、结论\n可上线\n\n## 二、逐项核验\n我实测了 stub。', 1)
  assert.equal(report.verdict, 'pass')
})

test('英文对冲/疑问式措辞也必须 fail-closed', () => {
  for (const verdict of [
    'maybe pass',
    'probably pass',
    'possibly pass',
    'likely pass',
    'mostly pass',
    'partial pass',
    'conditional pass',
    'pending pass',
    'pass?',
    'pass with concerns',
  ]) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  }
})

test('严格枚举下，带补充说明的合法结论仍识别正确', () => {
  const pass = ['pass（P0/P1 已清零）', 'pass, no P0/P1', 'approved (no blocking issues)', '可上线，无需人工复核']
  for (const verdict of pass) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'pass', `verdict=${verdict}`)
  }
  const reject = ['打回（P0-1）', 'reject（见下）']
  for (const verdict of reject) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'reject', `verdict=${verdict}`)
  }
})

test('同编号 JSON 与正文级别冲突时取更严重级别', () => {
  const text = `# 审核报告

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| P0-1 | P0 | 正文说 P0 | 无 | 无 |

\`\`\`json
{"verdict":"pass","issues":[{"id":"P0-1","severity":"P2","problem":"JSON 说 P2","reproduce":"r","suggestion":"s"}]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.equal(report.issues.find((issue) => issue.id === 'P0-1')?.severity, 'P0')
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
})

test('JSON 结论与正文结论矛盾时 fail-closed', () => {
  const text = `# 审核报告

## 一、结论
打回

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| — | — | 无 | — | — |

\`\`\`json
{"verdict":"pass","issues":[]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.equal(report.verdict, 'reject')
  assert.ok(report.issues.some((issue) => issue.id === 'P1-9'))
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
})

test('P2-19：带编号的正文结论也参与冲突检测', () => {
  const text = `# 审核报告

## 一、结论
打回（P0-1）

\`\`\`json
{"verdict":"pass","issues":[]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.equal(report.verdict, 'reject')
  assert.ok(report.issues.some((issue) => issue.id === 'P1-9'))
})

test('P2-20：结论在逗号后或带前缀说明时仍能识别 pass', () => {
  for (const verdict of ['P0/P1 已清零，可上线', '复核完成，可上线']) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'pass')
  }
})

test('P2-21：pass 带「P0 未修复」但书时 fail-closed', () => {
  for (const verdict of ['pass（P0 未修复）', 'pass, but P0 remains', '通过，但 P0 未修']) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  }
})

test('逗号拼接的对冲结论不得被合法分句绕过（probe18 回归）', () => {
  for (const verdict of [
    '可能通过，可上线',
    '尚需确认是否通过，可上线',
    '基本通过，可上线',
    '部分通过，可上线',
    '也许通过，可以上线',
    'maybe pass, 可上线',
    'probably pass，可上线',
    'pass?，可上线',
    'pass with concerns，可上线',
  ]) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  }
})

test('良性的逗号注记仍识别为 pass（P2-20 回归）', () => {
  for (const verdict of [
    'P0/P1 已清零，可上线',
    '复核完成，可上线',
    '已核对是否符合要求，可上线',
    '基本没有问题，可上线',
    '可上线，部分 P2 遗留',
    '结论：可上线',
  ]) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'pass', `verdict=${verdict}`)
  }
})

test('pass 带阻塞项但书时 fail-closed（P2-21 回归）', () => {
  for (const verdict of ['通过（存在 P0 问题）', '通过，但 P0 存在', '通过，P1 遗留']) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed`)
  }
})

test('中文否定式结论必须判为 reject（不能被子串「通过/可上线」骗过）', () => {
  for (const verdict of ['不通过', '未通过', '不可上线', '不能上线']) {
    const report = parseReviewReport(`# 审核报告\n\n\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应判 reject`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  }
})

test('逐项核验表里的 P0 字样不得被误判成 P0 问题', () => {
  const text = `# 审核报告（第 1 轮）

## 一、结论
可上线

## 二、逐项核验
| 核验项 | 我实测了什么 | 结果 |
|---|---|---|
| P0 扫描 | 全仓 grep getgetS7Biz | 无残留 |
| B 组 stub | 实测最坏耗时 12.06s → 1.2s | 通过 |

\`\`\`json
{"verdict":"pass","issues":[]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.equal(report.verdict, 'pass')
  assert.deepEqual(report.issues, [])
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, false)
})

test('未知措辞的结论一律 fail-closed（不因未知默认放行）', () => {
  for (const verdict of [
    '无法通过',
    '未能通过',
    '不予通过',
    '没有通过',
    '未获通过',
    '无法上线',
    '拒绝上线',
    '暂不上线',
    '条件未满足',
    'not approved',
    'no pass',
    'declined',
    '待定',
    '待验证',
    '需人工复核',
    '无法判断',
    'uncertain',
  ]) {
    const report = parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1)
    assert.equal(report.verdict, 'reject', `verdict=${verdict} 应 fail-closed 为 reject`)
    assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true, `verdict=${verdict} 应被门禁阻塞`)
  }
})

test('白名单内的肯定/否定措辞仍正确识别', () => {
  for (const verdict of ['pass', 'passed', 'approved', 'LGTM', '通过', '已通过', '可上线', '可以发布']) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'pass')
  }
  for (const verdict of ['reject', 'blocked', 'failed', '打回', '驳回', '不通过', '不可上线']) {
    assert.equal(parseReviewReport(`\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``, 1).verdict, 'reject')
  }
})

test('JSON 空 issues 与正文 P0 表格冲突时，按 fail-closed 采信正文', () => {
  const text = `# 审核报告

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| P0-9 | P0 | 正文列出的静默失效 | 无 | 无 |

\`\`\`json
{"verdict":"pass","issues":[]}
\`\`\``
  const report = parseReviewReport(text, 1)
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0].severity, 'P0')
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
})

test('响应表缺项时如实记录缺失编号', () => {
  const table = renderResponseTable(
    [{ id: 'P0-1', action: '已修复', changes: 'x', verification: 'y' }],
    1,
    ['P0-1', 'P1-2'],
  )
  assert.match(table, /缺少逐项响应：P1-2/)
})

test('结构化结果优先取最后一个 JSON 代码块', () => {
  const text = '前言\n```json\n{"a":1}\n```\n中间\n```json\n{"b":2}\n```\n结尾'
  assert.deepEqual(extractStructuredResult(text), { b: 2 })
})

test('解析审核者的 JSON 结论与问题', () => {
  const report = parseReviewReport(
    reviewerJson('reject', [
      { id: 'P0-1', severity: 'P0', problem: '批量替换后残留 getgetS7Biz', reproduce: 'grep -rn getgetS7Biz', suggestion: '修掉二次嵌套' },
    ]),
    1,
  )
  assert.equal(report.verdict, 'reject')
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0].id, 'P0-1')
  assert.equal(report.issues[0].severity, 'P0')
})

test('严重度归一化：无法识别按 P1 fail-closed', () => {
  assert.equal(normalizeSeverity('p0'), 'P0')
  assert.equal(normalizeSeverity('P2 建议'), 'P2')
  assert.equal(normalizeSeverity('high'), 'P1')
  assert.equal(normalizeSeverity(undefined), 'P1')
})

test('没有 JSON 时退回解析 Markdown 问题表', () => {
  const text = `# 审核报告（第 2 轮）

## 三、问题清单
| 编号 | 级别 | 问题 | 复现方式 | 建议 |
|---|---|---|---|---|
| P1-1 | P1 | 新锁换成空实现后用例仍 PASS | 故意改空实现实测 | 补断言 |
`
  const report = parseReviewReport(text, 2)
  assert.equal(report.verdict, 'reject')
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0].severity, 'P1')
  assert.equal(report.issues[0].suggestion, '补断言')
})

test('reject 但没有问题清单 → 补一条 P1 阻塞问题', () => {
  const text = reviewerJson('reject', [])
  const report = parseReviewReport(text, 1)
  assert.equal(report.verdict, 'reject')
  assert.equal(report.issues[0].severity, 'P1')
})

test('既无 JSON 也无问题表 → DUEL_REVIEW_UNPARSEABLE', () => {
  assert.throws(
    () => parseReviewReport('我觉得还行，可以上线。', 1),
    (error) => error instanceof DuelError && error.code === DUEL_ERROR_CODES.reviewUnparseable,
  )
})

test('门禁只按 blockOn 级别裁决', () => {
  const report = parseReviewReport(
    reviewerJson('reject', [
      { id: 'P0-1', severity: 'P0', problem: 'a', reproduce: 'r', suggestion: 's' },
      { id: 'P2-1', severity: 'P2', problem: 'b', reproduce: 'r', suggestion: 's' },
    ]),
    1,
  )
  assert.equal(evaluateGate(report, ['P0', 'P1']).blocked, true)
  assert.equal(evaluateGate(report, ['P2']).blocked, true)
  const onlyP2 = parseReviewReport(reviewerJson('reject', [{ id: 'P2-1', severity: 'P2', problem: 'b', reproduce: 'r', suggestion: 's' }]), 1)
  assert.equal(evaluateGate(onlyP2, ['P0', 'P1']).blocked, false)
})

test('解析编写者的自测清单、变更摘要与响应表', () => {
  const text = `已完成。

\`\`\`json
{
  "selfTests": ["node --test"],
  "changeSummary": { "src/a.ts": "修复残留" },
  "responses": [{ "id": "P0-1", "action": "已修复", "changes": "删除重复前缀", "verification": "grep 无残留" }]
}
\`\`\``
  const report = parseWriterReport(text)
  assert.deepEqual(report.selfTests, ['node --test'])
  assert.equal(report.changeSummary['src/a.ts'], '修复残留')
  assert.equal(report.responses[0].id, 'P0-1')
  assert.equal(report.responses[0].action, '已修复')
})

test('交接包只含需求/清单/diff/自测，不含编写者自述', () => {
  const markdown = buildDeliveryPackageMarkdown(
    {
      requirement: '把残留改名修掉',
      acceptance: 'grep 无残留',
      round: 2,
      files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, summary: '修复残留' }],
      diff: '- getgetS7Biz\n+ getS7Biz',
      truncated: false,
      selfTests: ['grep -rn getgetS7Biz'],
    },
    META,
  )
  assert.match(markdown, /## 三、变更文件清单/)
  assert.match(markdown, /## 四、diff/)
  assert.match(markdown, /## 五、自测/)
  assert.match(markdown, /getgetS7Biz/)
  assert.doesNotMatch(markdown, /上一轮报告全文/)
})

test('响应表渲染成文档要求的四列表', () => {
  const table = renderResponseTable(
    [{ id: 'P0-1', action: '已修复', changes: '删除重复前缀', verification: 'grep 无残留' }],
    1,
  )
  assert.match(table, /\| 审核编号 \| 处置 \| 修改内容 \| 验证方式 \|/)
  assert.match(table, /\| P0-1 \| 已修复 \| 删除重复前缀 \| grep 无残留 \|/)
})
