# @gjs27/dsh-context-compaction

DSH 原生上下文压缩引擎插件：继承官方 `BasicCompactionEngine`，只覆写 `summarize(input, agent, signal)` 钩子，提供分层增量摘要与关键信息保留规则；「更早且可调的自动压缩触发」通过官方策略配置键实现，不改动任何官方机制。

## 实现边界（与官方契约对齐）

- 引擎 `ContextCompactionEngine extends BasicCompactionEngine`（服务名/挂载行沿用 `compaction-basic`）；官方的 pre-step 压力触发、context-overflow 恢复、持久锁括号、surface replace、`compactionRetries`、与 `toolResultPruner` 协作全部原样继承，**未覆写** `compactIfNeeded` / `compactRegion` / `compactNow`（`test/engine-shape.test.mjs` 用原型链断言锁定）。
- 官方「摘要必须小于被压缩内容」硬校验（`dsh-compaction-basic` framed 检查点 vs 路由实价）**原样保留，不绕过**。
- `summarize()` 返回值逐字段判定，`undefined` 字段整体省略（`usage` 缺失时不出现该键）；`test/trigger-threshold.test.mjs` 用宿主 `snapshotJsonValue` 实测返回值可序列化。

## 分层增量摘要

被遮蔽区间内存在旧检查点（`<compacted-summary>` 块）时，指令进入增量模式：旧检查点是上下文输入，要求「保留仍成立的事实、删除已被推翻条目、合并新信息为统一检查点」，不重放原文（官方 surface replace 本就保证原文不进摘要输入）。

## 保留规则（采纳 acp-kernel 规则文本，MIT，不含其运行时）

文件绝对路径、代码标识符、命令原文与退出码、报错文本原文、用户硬性约束、未决事项、数值/版本号/URL/commit 哈希逐字保留；中文会话输出中文摘要（`auto` 按汉字占比判定），技术 token 在任何语言下保持原文。

## 配置

官方 11 键（`thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` / `summarizationProvider` / `summarizationModel` / `maxTokens` / `compactionRetries` / `maxOverflowRetries` / `modelPolicies` / `auto`）原样生效，由父类 resolver 校验；未知键仍被拒绝。

插件新增 3 键：

| 键 | 默认 | 说明 |
|---|---|---|
| `retentionInstructions` | `[]` | 追加到摘要指令的逐字保留规则（每条一个字符串） |
| `incremental` | `true` | 分层增量摘要开关 |
| `summaryLanguage` | `"auto"` | `"auto" \| "zh" \| "en"`，`auto` 按对话主语言判定 |

### 「触发更早」推荐配置（阈值公式：`thresholdTokens = floor(min(contextWindow × thresholdRatio, messageBudget − headroomTokens))`）

```json
{
  "thresholdRatio": 0.5,
  "headroomTokens": 32768,
  "retainRatio": 0.16
}
```

`thresholdRatio` 降到 0.5、`headroomTokens` 降半，压缩即在约 50% 占用触发（官方默认 0.8 + 65536 headroom）。**可复现证据**：`test/trigger-threshold.test.mjs` 用官方 `compactIfNeeded('pressure')` 全机制在固定 41% 占用（105000/256000 tokens）下实测——官方默认 `thresholdRatio: 0.8` 不触发（返回 null、摘要器零调用）；下调到 `0.35` 同一占用立即触发并提交完整官方事务（`compaction/start` → `compaction/summary` → `compaction/end` 无 error）。

## 已验证 / 未验证

已执行验证（exit 0）：
- `pnpm run typecheck`（tsc --noEmit）
- `pnpm run build`（产物 `lib/` 与 `src/` 同步，tsc 直译 + `lib/types/*.d.ts`）
- `node --test "test/**/*.test.mjs"`（18/18 通过）

未验证（交由 t4/t5 / 真实宿主）：
- 真实 DSH 启动后 preset isolate realm 内的挂载与 `summarize()` 动态派发（t1 U2/U3，属挂载与验证任务范围）；
- 真实 LLM 流（测试使用 stub `ctx.llm.stream`，chunk 形状对齐 `dsh-llm@0.2.0-rc.2` 类型）；
- preset 替换 patch（t5 交付）。

## 兼容性

- 宿主：DSH `0.2.0-rc.2`；`peerDependencies` 对 `@deepseek-ai/dsh*` 写**精确** `0.2.0-rc.2`（预发布排序下 `^0.2.0` 会被宿主兼容校验 deny，t1 §5.2）。
- 挂载：必须由本插件 bundle patch 整行替换 `preset-standard` / `preset-cordis` / `preset-ptc` 的 compaction 组 engine 行（t1 §4，t5 交付）；顶层行挂载无效。
