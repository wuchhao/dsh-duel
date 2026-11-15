# dsh-duel

> 让两个模型互博：一个写，一个独立审。AI 写的代码，靠对抗而不是靠自觉。

**dsh-duel** 是一个 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 插件，实现「编写 ↔ 审核 ↔ 实证」的双模型对抗闭环。

## 为什么

同一个模型「自己检查自己」会被编写时的思维惯性绑架——作者自查的盲区是结构性的。dsh-duel 的答案是：

- **编写模型**：改代码、写自测、跑通自测、更新变更日志
- **审核模型**：只看代码 diff 和需求，**不看编写模型的自查结论**，独立验证
- **硬门禁**：P0/P1 级问题清零才能出循环，不做礼貌性通过

## 安装

```bash
dsh plugin add dsh-duel
```

无需登录，无需注册，无需 API key（模型凭据复用你的 DSH 配置）。

## 配置

<<<<<<< HEAD
下面是 profile 片段（插件 id 为 `duel`，与 `cordis.patch.yml` 的 insert 行对应）：

=======
>>>>>>> 2e730201fdbcdaea7cdc36dcccea004d70d9dfd9
```json
{
  "duel": {
    "writer": {
      "model": "glm-4.7"
    },
    "reviewer": {
      "model": "deepseek-chat",
      "isolation": true
    },
    "gate": {
      "blockOn": ["P0", "P1"],
      "maxRounds": 3,
      "escalate": "human"
    },
    "deliverables": ["delivery-package", "review-report", "response-table"]
  }
}
```

<<<<<<< HEAD
| 字段 | 默认 | 说明 |
|---|---|---|
| `writer.provider` / `writer.model` | 继承父会话 | 编写层模型路由；只给 `model` 时沿用父会话 provider |
| `writer.maxTokens` | 模型默认 | 编写子代理单次回复的输出上限 |
| `writer.instruction` | 空 | 追加在编写基础提示词之后的自定义要求 |
| `reviewer.provider` / `reviewer.model` | 继承父会话 | 审核层模型。**与 writer 至少异构一个维度**（不同模型，或至少不同提示词人格） |
| `reviewer.maxTokens` | 模型默认 | 审核子代理单次回复的输出上限 |
| `reviewer.instruction` | 空 | 追加在审核基础提示词之后的自定义要求 |
| `reviewer.isolation` | `true` | 上下文隔离：审核者只见产物、不见过程。为 `true` 时不允许 `fork` 后端 |
| `gate.blockOn` | `["P0", "P1"]` | 命中即打回的级别；只接受 P0–P3，未包含 P0/P1 时启动告警 |
| `gate.maxRounds` | `3` | 最大循环轮次（1–10，总轮次上限，不是按单个问题计数）；超轮次按 `escalate` 处置 |
| `gate.escalate` | `"human"` | `human`：升级人工仲裁；`stop`：停在原地 |
| `deliverables` | 全部三类 | 落盘的交付物种类：`delivery-package` / `review-report` / `response-table` |
| `subagentProvider` | `"spawn"` | 子代理后端；`spawn` 为独立新会话，`fork` 继承父会话（与隔离互斥） |
| `deliverableDir` | `".dsh-duel"` | 交付物根目录（相对工作目录，不允许绝对路径/UNC/`..`） |
| `maxDiffChars` | `200000` | diff 字符上限；超出截断并在交接包标记 |
| `timeoutMs` | 不限 | 单次子代理调用的协作超时（毫秒）；省略表示不设截止 |

> 示例中的模型 id（`glm-4.7` / `deepseek-chat`）只是占位；请换成你的 DSH provider 实际注册的模型 id。只写 `model` 时沿用父会话 provider。

> 交付物写在 `<工作目录>/.dsh-duel/runs/<runId>/`，该目录会被排除在审核 diff 之外。

## 实战背书

这套闭环在一次真实生产改造中跑了五批迭代，全部数据来自 331 万行生产日志（数据来自作者的一次生产改造，不能由本仓库复现）：
=======
| 字段 | 说明 |
|---|---|
| `writer.model` | 编写层模型 |
| `reviewer.model` | 审核层模型。**与 writer 至少异构一个维度**（不同模型，或至少不同提示词人格） |
| `reviewer.isolation` | 上下文隔离：审核者只见产物、不见过程 |
| `gate.blockOn` | 硬门禁级别，命中即打回 |
| `gate.maxRounds` | 同一问题 N 轮未修透 → 升级人工 |

## 实战背书

这套闭环在一次真实生产改造中跑了五批迭代，全部数据来自 331 万行生产日志：
>>>>>>> 2e730201fdbcdaea7cdc36dcccea004d70d9dfd9

- 审核 1 条 grep 抓出批量替换 P0（接口静默失效）
- stub 实测戳穿「修了但没修透」（最坏耗时 12.06s 未降，TCP 拆建 ×6）
- ISO 超时 **32,962 → 0**，报文成功率 **93.6% → 98.6%**
- 审核抓到改造引入的写周期竞态回归（作者自查全绿之后）

<<<<<<< HEAD
详见实战记录：`docs/writer-reviewer-loop.md`（编写-审核循环规范）与 `docs/code-review-checklist.md`（审核 checklist）。
=======
详见实战记录：[S7 连接池改造：一套多模型编写-审核闭环是如何炼成的](https://github.com/YOUR-USERNAME/dsh-duel/blob/main/docs/case-s7-pool.md)
>>>>>>> 2e730201fdbcdaea7cdc36dcccea004d70d9dfd9

## 审核层七条硬手法

1. stub 实测主症状场景（不止读代码）
2. 回归用例鉴别力验证（故意引入缺陷，用例必须 FAIL）
3. 全仓残留扫描（批量替换后一条 grep）
4. 异常分类核对（捕获过宽会拆掉健康连接）
5. 锁路径审计（粒度缩小后原子性是否丢失）
6. 大日志统计加 `grep -a`（二进制字节截断陷阱）
7. 分位数实证（p50/p90/p99 + 超阈值事件计数，不看均值）

<<<<<<< HEAD
## 开发

```bash
pnpm install      # 类型依赖 + 测试运行时的 DSH 包
pnpm typecheck    # tsc --noEmit
pnpm build        # 产出 dist/
pnpm test         # 构建后跑 node:test（含仿 subagent 的端到端用例）
```

源码在 `src/`：

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口（`name` / `inject` / `Config` / `apply`） |
| `tools.ts` | 注册 `duel_run` / `duel_review` |
| `config.ts` | 配置 schema、默认值与交叉校验 |
| `prompts.ts` | 编写/审核提示词、审核 checklist、交接包与报告模板 |
| `diff.ts` | 捕获工作区 diff（含未跟踪文件、排除交付物目录） |
| `report.ts` | 解析审核结论、门禁裁决、摘要渲染 |
| `subagent.ts` | 子代理执行层（兼容新旧 subagents 入口） |
| `loop.ts` | 编写 ↔ 审核 ↔ 门禁的循环编排 |
| `deliverables.ts` | 交付物落盘与 run manifest |

工具：`duel_run`（完整闭环）、`duel_review`（只审核当前 diff）。交付物写在 `.dsh-duel/runs/<runId>/`。

## 已知限制

- **真实模型 / 真实宿主端到端未在本仓库验证**：测试用 fake subagent 覆盖了完整循环（含 `startActivation` 与旧版 `start` 两条入口），但真实 provider 的 abort/dispose/上下文种子行为取决于宿主版本。
- **子代理 API 版本差异**：插件用结构化探测兼容 `startActivation`（新版）与 `start(provider, request)`（早期版本）。若宿主版本签名不同，`runChild` 会以 `DUEL_CHILD_FAILED` / `DUEL_SUBAGENTS_UNAVAILABLE` 等稳定 code 失败，而不是静默降级。
- **审核者工具范围由宿主 preset 决定**：插件不能用提示词强制审核者只读；实现上通过「审核前后 diff 比对」发现越权改动，一旦发现即作废本轮报告并升级人工。
- **C 组（上线后效果实证）本仓库无法验证**：分位数、前后窗口、瓶颈转移需要生产日志与上线后第三方复核，见 `docs/code-review-checklist.md`。
- **`gate.maxRounds` 是总轮次上限**（不是按单个问题计数的连续未修轮次）；到达上限仍命中门禁即升级人工。

=======
>>>>>>> 2e730201fdbcdaea7cdc36dcccea004d70d9dfd9
## License

MIT
