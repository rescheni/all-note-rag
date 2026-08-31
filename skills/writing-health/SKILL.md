---
name: writing-health
description: 统计写作量、断更天数与无链孤岛笔记
version: 0.1.0
hooks: [weekly-report, on-ask]
permissions:
  spaces: current
  notes: read
  network: false
---

# writing-health

官方写作健康度 Skill。看当前空间（个人或团队）近两周字数、距上次更新的断更天数，以及没有任何入链/出链的孤岛笔记。

- **weekly-report**：写出 `skill_artifacts`（kind=`writing-health-report`），团队空间也可用。
- **on-ask**：提问涉及写作 / 断更 / 健康度时附加短摘要。

约束：

- 仅当前空间。无外网。看不到 Connection 源凭证。
- 只写中枢 `skill_artifacts`，**不写回任何编辑器**。
