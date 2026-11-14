# 新窗口开工话术（KICKOFF 模板）

> 用途：在新窗口/新会话启动某个重构阶段时，直接复制下面整段作为第一条消息。
> 前提：新窗口工作目录必须是 `K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud`（否则读不到基线与记忆）。
> 每阶段一份计划、一次授权——回「同意，按计划执行」才动代码（总纲 §六）。

---

```text
项目：wechat-pipeline-cloud。执行重构的「阶段 0 + 阶段 1A」。（按需改成只做一个）

最高约束：先完整读 docs/restructure/README.md 和 docs/restructure/00-FINAL-EXECUTION-CHARTER.md
（最终执行总纲，效力最高），全程遵守。设计基线在 docs/restructure/（01-08 + 09 实施前检查）。
历史 V1 文档（AUDIT-REPORT / RESTRUCTURE-CHECKLIST）已作废，不得引用其表设计（如 TopicCandidate）。
一切以 README 决策登记表（D1-D6/A/B/C/M/P/U/Q/X）为准。

工作方式（分阶段授权，必须遵守）：
1. 开工前先提交本阶段实施计划：目标 / 任务清单 / 受影响文件 / 数据库变更 / API 变更 /
   UI 变更 / 测试计划 / 风险与回滚方案。等我回复确认后才允许改代码。
2. 数据库写操作、迁移演练、测试一律用隔离库；禁止拿真实 dev.db / 生产库做试验。
3. 不删除、不破坏现有功能和历史数据；群发永远人工（AUTO_PUBLISH=false 不可动）。
4. 阶段结束提交：实际修改文件 / 完成情况 / 真实测试结果 / 与设计的差异 / 遗留问题。

本阶段范围：
· 阶段 0：按 RESTRUCTURE-ROADMAP-V2.md「阶段 0」执行——设计令牌合并（主色 #0a7c47 不改）、
  壳层与导航重排、统一三态组件、关键页低保真原型、真机浏览器走查。
· 阶段 1A：按 09-PRE-IMPLEMENTATION-CHECK.md §三执行——migration baseline（MySQL+SQLite
  双库隔离验证）、备份恢复演练、六赛道配置盘点。
每步收尾：npm run typecheck + smoke:lint + smoke:style + smoke:angles 全绿。

现在先输出两份实施计划（阶段 0、阶段 1A 各一份）让我确认，不要直接动手。
```

---

## 变体

- **只做阶段 0**：范围只留「阶段 0」段，结尾改「先输出阶段 0 实施计划」。
- **只做阶段 1A**：同理。
- **后续阶段（2/3/4/5）**：把范围段换成 ROADMAP-V2 对应阶段原文。
- **短版**（记忆已加载时）：`按 docs/restructure/00-FINAL-EXECUTION-CHARTER.md（总纲）执行阶段 X：先交实施计划待我确认，再动代码；数据库一律隔离库。`

## 计划确认话术

- 同意：`同意，按计划执行。`
- 带修改：`同意，但以下几点调整：…（列出）`
- 打回：`计划有问题：…（说明），重新提交。`
