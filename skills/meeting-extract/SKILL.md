---
name: meeting-extract
description: 从会议纪要抽取参会人、决议与待办
version: 0.1.0
hooks: [post-sync]
permissions:
  spaces: current
  notes: read
  network: false
---

# meeting-extract

官方会议纪要抽取 Skill。同步后识别会议笔记，抽出参会人 / 决议 / 待办，写入中枢 `skill_artifacts`（kind=`meeting`）。

- **post-sync**：标题、路径或标签含「会议 / meeting / 纪要」，或 frontmatter `type: meeting` 时解析正文。
- 解析为空则跳过，不打断同步。

约束：

- 仅当前空间（个人或团队均可）。
- 无外网。看不到 Connection 源凭证。
- 只写中枢 `skill_artifacts`，**不写回任何编辑器**。
