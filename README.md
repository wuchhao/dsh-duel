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

| 字段 | 说明 |
|---|---|
| `writer.model` | 编写层模型 |
| `reviewer.model` | 审核层模型。**与 writer 至少异构一个维度**（不同模型，或至少不同提示词人格） |
| `reviewer.isolation` | 上下文隔离：审核者只见产物、不见过程 |
| `gate.blockOn` | 硬门禁级别，命中即打回 |
| `gate.maxRounds` | 同一问题 N 轮未修透 → 升级人工 |

## 实战背书

这套闭环在一次真实生产改造中跑了五批迭代，全部数据来自 331 万行生产日志：

- 审核 1 条 grep 抓出批量替换 P0（接口静默失效）
- stub 实测戳穿「修了但没修透」（最坏耗时 12.06s 未降，TCP 拆建 ×6）
- ISO 超时 **32,962 → 0**，报文成功率 **93.6% → 98.6%**
- 审核抓到改造引入的写周期竞态回归（作者自查全绿之后）

详见实战记录：[S7 连接池改造：一套多模型编写-审核闭环是如何炼成的](https://github.com/YOUR-USERNAME/dsh-duel/blob/main/docs/case-s7-pool.md)

## 审核层七条硬手法

1. stub 实测主症状场景（不止读代码）
2. 回归用例鉴别力验证（故意引入缺陷，用例必须 FAIL）
3. 全仓残留扫描（批量替换后一条 grep）
4. 异常分类核对（捕获过宽会拆掉健康连接）
5. 锁路径审计（粒度缩小后原子性是否丢失）
6. 大日志统计加 `grep -a`（二进制字节截断陷阱）
7. 分位数实证（p50/p90/p99 + 超阈值事件计数，不看均值）

## License

MIT
