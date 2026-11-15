/**
 * 审核报告解析与门禁裁决。
 *
 * 审核者的正文按 `docs/writer-reviewer-loop.md` 的模板写，机器可读结论放在
 * 回复最后一个 ```json 代码块里。这里优先解析 JSON；拿不到时退回解析
 * Markdown 问题表，保证门禁不会因为格式抖动而误放行（无法解析按 fail-closed 处理）。
 * @module dsh-duel/report
 */

import { DUEL_ERROR_CODES, DuelError } from './errors.js'
import { renderIssuesTable } from './prompts.js'
import { SEVERITIES } from './types.js'
import type { DuelRunResult, GateDecision, Issue, ReviewReport, Severity, WriterReport, WriterResponse } from './types.js'

export { renderIssuesTable } from './prompts.js'

/** 从文本中提取全部代码块内容。 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = []
  const pattern = /```[^\n]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1]
    if (body !== undefined) blocks.push(body.trim())
  }
  return blocks
}

/** 解析任意 JSON 值；失败返回 undefined。 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 从回复中取最后一个可解析的 JSON 对象。 */
export function extractStructuredResult(text: string): Record<string, unknown> | undefined {
  const candidates = [...extractCodeBlocks(text)].reverse()
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  for (const candidate of candidates) {
    const value = tryParseJson(candidate)
    if (isRecord(value)) return value
  }
  return undefined
}

/** 是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取一个字符串字段（支持多个候选键）。 */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** 读取一个字符串数组字段。 */
function pickStringArray(source: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    }
    if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  }
  return []
}

/** 把任意严重度标记规范化为 `P0`..`P3`；无法识别时按 P1 处理（fail-closed）。 */
export function normalizeSeverity(value: unknown): Severity {
  if (typeof value === 'string') {
    const match = /P\s*([0-3])/i.exec(value)
    if (match !== null) {
      const level = match[1]
      const candidate = `P${level ?? '1'}`
      if ((SEVERITIES as readonly string[]).includes(candidate)) return candidate as Severity
    }
  }
  return 'P1'
}

/**
 * 解析 Markdown 问题表。只解析「问题清单」小节里、表头含「编号/级别」的表格，
 * 避免把「逐项核验」表里的 `P0 扫描` 之类的核验项误判成 P0 问题（假阳性会
 * 让合法改动被门禁打回）。
 */
function parseMarkdownIssues(text: string): Issue[] {
  const lines = text.split('\n')
  const startIndex = lines.findIndex((line) => /问题清单|问题列表|issues?\b/i.test(line))
  const scope = startIndex >= 0 ? lines.slice(startIndex + 1) : lines
  const issues: Issue[] = []
  let headerSeen = false
  for (const line of scope) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      headerSeen = false
      continue
    }
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    const hasIdHeader = cells.some((cell) => /编号|id\b|no\.?/i.test(cell))
    const hasSeverityHeader = cells.some((cell) => /级别|严重|severity|level|priority/i.test(cell))
    if (!headerSeen && hasIdHeader && hasSeverityHeader) {
      headerSeen = true
      continue
    }
    if (!headerSeen) continue
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    if (cells.length < 3) continue
    const [idCell = '', severityCell = '', problemCell = '', reproduceCell = '', suggestionCell = ''] = cells
    if (!/P\s*[0-3]/i.test(severityCell) && !/P\s*[0-3]/i.test(idCell)) continue
    const severity = normalizeSeverity(/P\s*[0-3]/i.test(severityCell) ? severityCell : idCell)
    issues.push({
      id: idCell.length > 0 ? idCell : `P${severity.slice(1)}-${issues.length + 1}`,
      severity,
      problem: problemCell,
      reproduce: reproduceCell,
      suggestion: suggestionCell,
    })
  }
  return issues
}

/** 严格白名单：只有这些完整措辞才允许判定为已放行 / 已打回。 */
const PASS_TOKENS = new Set([
  'pass',
  'passed',
  'approve',
  'approved',
  'lgtm',
  'ok',
  '通过',
  '已通过',
  '可上线',
  '可以上线',
  '准予上线',
  '准予发布',
  '放行',
  '达标',
  '合格',
  '可以发布',
])

/** 严格否定白名单。 */
const REJECT_TOKENS = new Set([
  'reject',
  'rejected',
  'blocked',
  'fail',
  'failed',
  'declined',
  '不通过',
  '未通过',
  '不可上线',
  '不能上线',
  '无法通过',
  '打回',
  '驳回',
  '不达标',
  '需人工复核',
  '待定',
  '待验证',
])

/**
 * 判定一个「通过 + 但书」是否自相矛盾：`pass（P0 未修复）`、`通过，但 P0 存在`
 * 这类结论里明确写着阻塞项仍在，绝不能因为主词是 pass 就放行。
 */
function hasBlockingContradiction(text: string): boolean {
  const markers =
    '未修复|未修|未清零|未解决|没修复|仍有|尚有|依然存在|存在|遗留|残留|remaining|remains|not\\s+fixed|unfixed|still\\s+(open|failing)'
  return (
    new RegExp(`(${markers})[^。；;\\n]{0,16}\\b(p0|p1)\\b`, 'i').test(text) ||
    new RegExp(`\\b(p0|p1)\\b[^。；;\\n]{0,16}(${markers})`, 'i').test(text)
  )
}

/**
 * 对冲 / 未决措辞：出现在结论任意位置都不能当放行。
 * 只把「部分通过 / 基本通过」这类对冲当未决，不把「部分 P2 遗留」这类良性注记
 * 误判；「已核对是否符合要求」里的「是否」也不算未决。
 */
function hasHedge(text: string): boolean {
  return /可能|也许|或许|大概|大概率|部分通过|基本通过|有条件|尚需|需要?确认|待确认|(?<!无)需要?人工|请人工|与否|不确定|未确定|未决|待定|待验证|需复核/.test(
    text,
  ) ||
    /maybe|probably|possibly|likely|mostly|partial|conditional|pending|concern|tentative|draft|unsure|unclear|not\s+sure/.test(
      text,
    ) ||
    /[?？]/.test(text)
}

/**
 * 把审核结论文本归一化为 pass/reject。
 *
 * 顺序不可交换：
 * 1. 但书里写明 P0/P1 未清 → reject；
 * 2. 任意位置出现对冲/未决措辞 → reject（否则 `可能通过，可上线` 会被逗号分句绕过）；
 * 3. 精确白名单匹配整句或任一分句；
 * 4. 其它未知措辞返回 undefined，由调用方 fail-closed。
 */
function normalizeVerdict(raw: string): ReviewReport['verdict'] | undefined {
  const text = raw.trim().toLowerCase()
  if (text.length === 0) return undefined
  if (hasBlockingContradiction(text)) return 'reject'
  if (hasHedge(text)) return 'reject'

  const core = (value: string): string =>
    value
      .replace(/^结论[:：\s]*/, '')
      .replace(/[（(].*$/, '')
      .replace(/[。.!！;；:：\s]+$/, '')
      .trim()

  const whole = core(text)
  if (REJECT_TOKENS.has(whole)) return 'reject'
  if (PASS_TOKENS.has(whole)) return 'pass'

  const segments = text
    .split(/[,，]/)
    .map((segment) => core(segment))
    .filter((segment) => segment.length > 0)
  if (segments.some((segment) => REJECT_TOKENS.has(segment))) return 'reject'
  if (segments.some((segment) => PASS_TOKENS.has(segment))) return 'pass'
  return undefined
}

/**
 * 从审核报告正文提取结论句（JSON 缺 verdict 时的兜底）。
 * 只读「结论」标题后的第一行正文；模板占位符与标题行会被跳过。
 */
function conclusionFromBody(text: string): string {
  const lines = text.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => /结论/.test(line) && !/^\s*\|/.test(line))
  if (headingIndex < 0) return ''

  const heading = (lines[headingIndex] ?? '').replace(/^[#>\-*\s]+/, '').trim()
  const inline = heading.replace(/^.*?结论[:：\s]+/, '').trim()
  if (inline.length > 0 && !/^[一二三四五六七八九十\d]+、/.test(inline) && !/^[#>\-*]/.test(inline)) {
    return inline
  }

  for (let index = headingIndex + 1; index < Math.min(lines.length, headingIndex + 8); index++) {
    const candidate = (lines[index] ?? '')
      .replace(/^[#>\-*\s]+/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (candidate.length === 0) continue
    if (/^[一二三四五六七八九十\d]+、/.test(candidate)) continue
    if (candidate.startsWith('|')) continue
    return candidate
  }
  return ''
}

/** 解析编写者的机器可读交接块。 */
export function parseWriterReport(text: string): WriterReport {
  const structured = extractStructuredResult(text)
  const selfTests = structured === undefined ? [] : pickStringArray(structured, ['selfTests', 'self_tests', 'tests'])
  const responses: WriterResponse[] = []
  if (structured !== undefined) {
    const rawResponses = structured['responses'] ?? structured['responseTable'] ?? structured['response_table']
    if (Array.isArray(rawResponses)) {
      rawResponses.forEach((item, index) => {
        if (!isRecord(item)) return
        const id = pickString(item, ['id', 'no', 'number']) || `R-${index + 1}`
        responses.push({
          id,
          action: pickString(item, ['action', 'disposition', 'status']) || '未说明',
          changes: pickString(item, ['changes', 'change', 'detail']),
          verification: pickString(item, ['verification', 'verify', 'evidence']),
        })
      })
    }
  }
  const changeSummary: Record<string, string> = {}
  if (structured !== undefined) {
    const rawSummary = structured['changeSummary'] ?? structured['change_summary'] ?? structured['changes']
    if (isRecord(rawSummary)) {
      for (const [path, summary] of Object.entries(rawSummary)) {
        if (typeof summary === 'string' && summary.trim().length > 0) changeSummary[path] = summary.trim()
      }
    }
  }
  return { selfTests, changeSummary, responses, raw: text }
}

/** 严重度排序，数字越小越严重。 */
function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

/** 解析审核者的最终回复。 */
export function parseReviewReport(text: string, round: number): ReviewReport {
  const structured = extractStructuredResult(text)
  const issues: Issue[] = []
  let verdictRaw = ''
  let jsonIssuesProvided = false

  if (structured !== undefined) {
    verdictRaw = pickString(structured, ['verdict', 'conclusion', 'result'])
    const issuesKey = ['issues', 'problems', 'findings'].find((key) => key in structured)
    if (issuesKey !== undefined) {
      const rawIssues = structured[issuesKey]
      if (!Array.isArray(rawIssues)) {
        throw new DuelError(
          DUEL_ERROR_CODES.reviewUnparseable,
          `审核者的 \`${issuesKey}\` 字段存在但不是数组（收到 ${typeof rawIssues}）；问题清单无法解析，按 fail-closed 处理`,
        )
      }
      if (rawIssues.some((item) => !isRecord(item))) {
        throw new DuelError(
          DUEL_ERROR_CODES.reviewUnparseable,
          `审核者的 \`${issuesKey}\` 数组元素必须是对象；问题清单无法解析，按 fail-closed 处理`,
        )
      }
      jsonIssuesProvided = true
      rawIssues.forEach((item, index) => {
        const severity = normalizeSeverity(item['severity'] ?? item['level'] ?? item['priority'] ?? item['id'])
        issues.push({
          id: pickString(item, ['id', 'no', 'number']) || `P${severity.slice(1)}-${index + 1}`,
          severity,
          problem: pickString(item, ['problem', 'issue', 'description', 'title']),
          reproduce: pickString(item, ['reproduce', 'repro', 'reproduction', 'evidence']) || '未实测',
          suggestion: pickString(item, ['suggestion', 'fix', 'advice']) || '未给出建议',
        })
      })
    }
  }

  // 无论 JSON 是否给出 issues，都扫描正文「问题清单」：JSON 只说 P2、正文列 P0
  // 这类冲突必须按 fail-closed 采信正文；同编号取更严重的级别。
  const bodyIssues = parseMarkdownIssues(text)
  if (!jsonIssuesProvided) {
    issues.push(...bodyIssues)
  } else {
    for (const bodyIssue of bodyIssues) {
      const index = issues.findIndex((existing) => existing.id === bodyIssue.id)
      if (index < 0) {
        issues.push(bodyIssue)
        continue
      }
      const existing = issues[index]
      if (existing !== undefined && severityRank(bodyIssue.severity) < severityRank(existing.severity)) {
        issues[index] = bodyIssue
      }
    }
  }

  // JSON 缺 verdict 时读正文「结论」小节，避免正文明确写「打回」而 issues=[] 被放行。
  const jsonVerdictText = verdictRaw
  const bodyConclusionText = conclusionFromBody(text)
  const jsonVerdict = normalizeVerdict(jsonVerdictText)
  const bodyVerdict = normalizeVerdict(bodyConclusionText)
  const verdictConflict = jsonVerdict !== undefined && bodyVerdict !== undefined && jsonVerdict !== bodyVerdict
  if (jsonVerdictText.trim().length === 0) verdictRaw = bodyConclusionText

  // 结论归一化：白/黑名单措辞 → 已知结论；明确给了结论但措辞不在白名单 →
  // fail-closed 打回（未知措辞绝不能默认放行）；完全没给结论才按问题推断。
  const normalizedVerdict = normalizeVerdict(verdictRaw)
  let verdict: ReviewReport['verdict']
  if (normalizedVerdict !== undefined) {
    verdict = normalizedVerdict
  } else if (verdictRaw.trim().length > 0) {
    verdict = 'reject'
    issues.push({
      id: 'P1-0',
      severity: 'P1',
      problem: `审核结论无法识别（"${verdictRaw.trim()}"）；按 fail-closed 视为打回，避免未知措辞被当成放行`,
      reproduce: '未实测',
      suggestion: '要求审核者只用 pass/reject，或明确的「通过/打回」措辞',
    })
  } else {
    verdict = issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1') ? 'reject' : 'pass'
  }

  // JSON 结论与正文结论互相矛盾 → fail-closed 打回（两处都可能被编写者污染）。
  if (verdictConflict) {
    verdict = 'reject'
    if (!issues.some((issue) => issue.id === 'P1-9')) {
      issues.push({
        id: 'P1-9',
        severity: 'P1',
        problem: `审核结论自相矛盾：JSON verdict="${jsonVerdictText.trim()}"，正文结论="${bodyConclusionText.trim()}"；按 fail-closed 打回`,
        reproduce: '未实测',
        suggestion: '要求审核者在正文与 JSON 中给出一致结论',
      })
    }
  }

  if (verdict === 'reject' && issues.length === 0) {
    issues.push({
      id: 'P1-0',
      severity: 'P1',
      problem: '审核结论为 reject，但问题清单为空或无法解析；按 fail-closed 视为存在阻塞问题',
      reproduce: '未实测',
      suggestion: '要求审核者按模板给出问题编号与实测证据',
    })
  }

  const residual = structured === undefined ? [] : pickStringArray(structured, ['residual', 'residuals', 'leftover'])

  if (verdictRaw.trim().length === 0 && issues.length === 0) {
    throw new DuelError(
      DUEL_ERROR_CODES.reviewUnparseable,
      '审核者回复里找不到可解析的结论（既没有 JSON 代码块，也没有问题表/结论句）；请检查审核提示词或审核模型输出',
    )
  }

  return { round, verdict, issues, residual, raw: text }
}

/**
 * 门禁裁决：命中 `blockOn` 级别的问题即打回。
 * @param report - 审核报告。
 * @param blockOn - 硬门禁级别。
 * @returns 是否打回与命中的阻塞问题。
 */
export function evaluateGate(report: ReviewReport, blockOn: readonly Severity[]): GateDecision {
  const blocking = report.issues.filter((issue) => blockOn.includes(issue.severity))
  return { blocked: blocking.length > 0, blocking }
}

/** 判断审核者是否改动了工作区（隔离之外的安全检查）。 */
export function workspaceMutated(before: string, after: string): boolean {
  return before !== after
}

/** 组装审核报告交付物。 */
export function renderReviewReportFile(report: ReviewReport, meta: { readonly writerModel: string; readonly reviewerModel: string }): string {
  const header = `<!-- dsh-duel review round ${report.round} | writer ${meta.writerModel} | reviewer ${meta.reviewerModel} -->`
  const body = report.raw.trim()
  if (body.includes('## 三、问题清单')) return `${header}\n\n${body}\n`
  const verdictText = report.verdict === 'pass' ? 'pass（可上线）' : 'reject（打回）'
  return `${header}\n\n# dsh-duel 审核报告（第 ${report.round} 轮）

## 一、结论
${verdictText}

## 二、逐项核验
审核者未按模板输出正文；以下为其原始回复。

${body}
`
}

/** 渲染一份人读摘要（工具返回值里的 summary 字段）。 */
export function renderRunSummary(result: Omit<DuelRunResult, 'summary'>, gateLevels: readonly string[] = ['P0', 'P1']): string {
  const gateText = gateLevels.join('/')
  const statusText: Record<DuelRunResult['status'], string> = {
    passed: `已通过（命中门禁的 ${gateText} 问题清零）`,
    escalated: `升级人工仲裁（${gateText} 未清零，或审核完整性受损）`,
    rejected: `未通过（按配置停在原地，${gateText} 未清零）`,
    error: '执行出错',
  }
  const lines: string[] = [
    `# dsh-duel 结果：${statusText[result.status]}`,
    '',
    `- 轮次：${result.rounds}`,
    `- 编写模型：${result.writerModel}`,
    `- 审核模型：${result.reviewerModel}`,
    `- 门禁级别：${gateText}`,
    `- 交付物目录：${result.runDir ?? '（无）'}`,
  ]
  if (result.files.length > 0) {
    lines.push(`- 交付物：${result.files.join('、')}`)
  }
  lines.push('', '## 问题清单', '', '| 编号 | 级别 | 问题 | 复现方式 | 建议 |', '|---|---|---|---|---|', renderIssuesTable(result.issues))
  if (result.blocking.length > 0) {
    lines.push('', `命中的硬门禁问题：${result.blocking.map((issue) => issue.id).join('、')}`)
  } else if (result.issues.length > 0) {
    lines.push('', '无命中门禁的问题；其余问题已记录台账，可进入人工终审。')
  }
  if (result.status === 'escalated' || result.status === 'rejected') {
    lines.push(
      '',
      '## 需要人工动作',
      `1. 打开 \`${result.runDir ?? '.dsh-duel'}\` 下的 \`review-report-*.md\` 与 \`response-table-*.md\`；`,
      '2. 逐项裁决遗留问题（修复 / 接受风险 / 调整需求）；',
      '3. 插件不会自动继续，也不会把未清零的改动放行。',
    )
  }
  return lines.join('\n')
}
