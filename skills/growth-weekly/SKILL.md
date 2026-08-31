---
name: growth-weekly
description: 汇总本周个人成长事件并生成简报
version: 0.1.0
hooks: [post-sync, on-ask, weekly-report]
permissions:
  spaces: current
  growth: write
  notes: read
---

# growth-weekly

官方个人成长 Skill。从个人空间笔记启发式抽取 `GrowthEvent`，并生成周报。

- **post-sync**：笔记 hash 变化后抽取目标 / 习惯 / 心情 / 复盘 / 专注事件。
- **weekly-report**：汇总近 7 天事件，写出中枢侧 Markdown 周报。
- **on-ask**：当提问涉及成长 / 周报 / 目标 / 习惯时，附加一段短摘要。

约束：

- 仅当前个人空间。团队空间不写、不查成长事件。
- 无外网。看不到 Connection 源凭证。
- 只写中枢 `growth_events` / `growth_reports`，**不写回任何编辑器**。
