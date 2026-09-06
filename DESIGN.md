---
name: 笔记中枢
description: 窗边热茶翻笔记。暖日、宣纸、苔藓缝线；只读聚合层，不是仪表盘。
colors:
  desk: "#f3eee4"
  rail: "#ebe3d4"
  paper: "#fffaf2"
  ink: "#3c332c"
  muted: "#8a7d70"
  line: "#e4d9c8"
  accent: "#5e8a68"
  accent-hover: "#4e7a58"
  on-accent: "#fffaf2"
  danger: "#c45c5c"
  focus: "#5e8a68"
  placeholder: "#6e6258"
  preview-paper: "#fffaf2"
  scrollbar: "#cbbfae"
typography:
  display:
    fontFamily: "Noto Serif SC, Songti SC, Noto Sans SC, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.01em"
  title:
    fontFamily: "Noto Serif SC, Songti SC, Noto Sans SC, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "normal"
  body:
    fontFamily: "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
rounded:
  sm: "12px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "0.45rem 0.95rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.45rem 0.95rem"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.7rem"
  rail-link-active:
    backgroundColor: "rgba(94, 138, 104, 0.16)"
    textColor: "{colors.ink}"
  tree-row-active:
    backgroundColor: "rgba(94, 138, 104, 0.14)"
    textColor: "{colors.ink}"
---

## Overview

窗边热茶翻笔记。暖日光从左侧进来，底是米纸，栏是亚麻，字是墨，动作只用一枚苔藓绿。中枢仍是只读聚合层：树、路径、同步「文件 / 数据块」不变。过渡要短：路由 clip 收束、导航弹簧缝线、树开合、主按钮抹茶纸面眩光。禁止电青、发丝网格、霓虹辉光。尊重 `prefers-reduced-motion`。

## Colors

暖浅阶 + 一枚抹茶。

| Token | Hex | Use |
|---|---|---|
| desk | `#f3eee4` | 页面底。米纸，不是纯白 |
| rail | `#ebe3d4` | 左栏、目录树底。亚麻 |
| paper | `#fffaf2` | 抬起的表面：表单、悬停行 |
| ink | `#3c332c` | 正文、标题 |
| muted | `#8a7d70` | 次要说明 |
| line | `#e4d9c8` | 分割，不是网格 |
| accent | `#5e8a68` | 主按钮、当前导航苔藓洗、同步中、热力图高档 |
| danger | `#c45c5c` | 错误文案；同步失败同时用文字 |
| focus | `#5e8a68` | 键盘焦点环 |
| preview-paper | `#fffaf2` | 笔记 iframe 里的源文 |

选择、插入符、滚动条都从这套色来。


## Themes

三套连贯配色，经设置页切换，写在 `hub_settings`（`theme:<user_id>`），`data-theme` 挂在 `<html>`。

| id | 名 | 用途 |
|---|---|---|
| matcha（默认，无 attribute） | 抹茶纸色 | 暖日宣纸，本色 |
| ink | 墨夜 | 暖墨深色阅读 |
| plain | 素白 | 更安静的浅色 |

禁止霓虹皮肤。默认必须保持抹茶纸色优秀。

## Typography

- 品牌、h1/h2：`Noto Serif SC`，600。
- 导航、按钮、表单、树、列表：`Noto Sans SC`。
- 路径、代码：系统等宽，不作展示字体。
- 禁止 Outfit / IBM Plex 作标题；禁止 Inter 打天下；禁止电青科技风。
- 比例收紧：h1 1.5rem，h2 1.125rem，正文 0.9375rem，标签 0.8125rem。

## Layout

- 壳：左栏约 `11.25rem` + 主栏。亚麻右线。
- 笔记页：`目录树 | 列表/预览`。树在左，按源分组（我的思源 / Obsidian / 飞书），默认展开前两层（源根 + 笔记本），不展开附件夹。
- 首页：空间工具条 → 活动热力图 → 接入源 → `连接 | 最近笔记`。
- 设置 `/settings`：AI 端点（Base URL + API Key）。
- 表单最大约 880px；登录/注册收在 `22rem`。
- 760px 以下：左栏收成顶栏横滑。

## Motion

短、有物理、无霓虹。CSS 为主；Motion 只用于导航弹簧、源胶囊共享布局、主按钮抹茶眩光。每页一个作者时刻，不要每块相同 fade。

- 路由：clip-path + 轻模糊，从已可见状态收束（不是 300ms 整页淡入）
- 导航：苔藓浅底；左侧缝线弹簧跟随 hover / active；链接轻微磁吸
- 树：开合高度 + 透明度；当前行左侧苔藓缝
- 卡片 / 行 / 胶囊：hover 轻抬、press scale、墨/苔藓色 morph
- 主 CTA：抹茶纸面眩光（保存并同步、登录）；飞书扫码纸面 clip 收束
- 列表：20–40ms stagger（总延迟封顶）
- 热力图：格子 stagger；悬停轻微放大
- 进度条：width 400ms

`prefers-reduced-motion: reduce` 时关掉位移、交错、眩光追踪，保留颜色变化。

## Elevation & Depth

米纸分层。阴影带偏移和柔边（`0 6px 18px`），不用零偏移色晕。圆角约 `12px`。

## Shapes

圆角一律约 `12px`。胶囊只用于源 chip 和状态 pill。

图标：同一笔触（1.5 / 16px）描边 SVG。禁止 emoji 当图标。

## Components

- **主按钮**：苔藓底、米纸字。Hover 略深，轻阴影，无 neon glow。
- **输入**：paper 底、line 边、苔藓插入符。焦点环无辉光。
- **树**：当前节点苔藓浅底。开合 220ms。空树：「同步后这里会出现源里的目录」。
- **热力图**：53 周 × 7 行，苔藓色阶。Tooltip `3 篇 · 3月12日`。
- **预览 iframe**：源文奶油纸色；外壳仍是米纸中枢。

## Do's and Don'ts

**Do**

- 顺着 path 走：树、面包屑、列表。
- 苔藓只用在动作、当前位置、热力高档。
- 空状态教人下一步。
- 中文短句。产品三词：克制、可溯、锋利。

**Don't**

- 电青、发丝网格、辉光、近黑底。
- Outfit / IBM Plex 作展示；Inter 打天下。
- 只有奶油 + 陶土衬线的通用 AI 治愈套装。
- 卡片套卡片、kicker/eyebrow、hero-metric。
- 大块只读警告条。
- Unicode 当图标。
