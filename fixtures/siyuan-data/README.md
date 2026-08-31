# 思源夹具

`workspace/` 是明文工作区（模式 B）：

- `workspace/data/20200813053000-boxdemo/` 演示笔记本（两篇 `.sy`：父文档 + 子文档）
- `workspace/data/20200813055999-encnote/` 加密笔记本（`encrypted: true` + 密文 `.sy`，必须跳过）
- `workspace/temp/blocktree.db` 可重建索引，不当作源
- `workspace/data/assets/hello.txt` 全局资源

`official-repo/repo/` 模拟官方 S3 dejavu 快照。v1 **不解包**，连接向导与适配器必须拒绝。
