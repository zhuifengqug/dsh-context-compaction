# @gjs27/dsh-context-compaction

给 DeepSeek Harness 用的**原生上下文压缩插件**：让自动压缩触发得更早、更可调，摘要更懂得保留关键信息，并且压缩掉了什么你随时能查。

不需要代理、不需要改 DSH 安装目录、不拦截任何官方请求。

---

## 它解决什么问题

DSH 官方的上下文压缩（`compaction-basic`）有几个让人难受的地方：

| 情况 | 官方默认行为 | 本插件 |
|---|---|---|
| 什么时候压缩 | 上下文占满模型窗口 **80%** 才触发 | 可在设置页拖到 **50%**，续航立刻变长 |
| 摘要保留什么 | 通用摘要，细节容易丢 | 逐字保留文件路径、命令、报错原文、你的硬性约束 |
| 上一轮摘要怎么处理 | 直接当作旧内容 | **增量合并**：保留仍成立的事实、删掉已被推翻的，合成一份新检查点 |
| 压缩掉了什么 | 看不到 | 三个工具可查、可导出原文 |

关键：**官方机制一个都没改**。压力触发、溢出恢复、持久锁、surface replace、`compactionRetries`、与 `toolResultPruner` 的协作，全部原样继承（有原型链断言测试锁死）。官方「摘要必须小于被压缩内容」的硬校验也原样保留，不绕过。

---

## 安装

```bash
# 1. 取得插件
git clone https://github.com/zhuifengqug/dsh-context-compaction.git
cd dsh-context-compaction

# 2. 构建（lib/ 不入库，必须自己构建）
pnpm install
pnpm run build
```

### 接入 profile

编辑 `$DSH_HOME/profiles/<你的 profile>/package.json`：

```jsonc
{
  "dependencies": {
    "@gjs27/dsh-context-compaction": "link:/绝对路径/dsh-context-compaction"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@gjs27/dsh-context-compaction"
      ]
    }
  }
}
```

然后**重启 DSH Desktop**。插件通过自身 `dsh.bundle` 挂载，无需手写 patch。

> 本机实测环境：`$DSH_HOME=D:\DSHData\home`，profile 目录 `D:\DSHData\home\profiles\desktop`。

---

## 使用

### 调节触发阈值

重启后打开 **设置**，左侧导航会多一项 **「上下文压缩」**：

- **快捷档位**：激进（约 50%）/ 温和（约 65%）/ 保守（官方 80%）
- **触发阈值比例**：数字框 + 滑块联动
- **预留 token**：在比例预算之外额外预留的量
- **高级**（可折叠）：保留尾部比例、保留尾部 token

每个字段都标注官方默认值，顶部显示**当前来源**（你的设置 / 官方默认）。

点保存后写入 `$DSH_HOME/context-compaction.json`。

> **生效时机**：引擎在 preset 挂载时读取该文件，而 DSH 的 preset 插件树在进程内按 revision 共享挂载。因此**改完设置请重启 DSH** 再观察；重启前已挂载的 preset 仍用旧值。

### 三个查询工具

压缩之后，模型（或你）可以直接问：

| 工具 | 作用 |
|---|---|
| `context_status` | 当前上下文占用、阈值策略、本会话所有已压缩区间 |
| `context_search` | 在会话里搜文本，可只搜「被压缩掉的原文」（`surface=shadowed`） |
| `context_expand` | 按 seq 区间读取被压缩的原文，并**导出为工作区文件** |

> **注意**：DSH 宿主没有「撤销替换」API，所以 `context_expand` **不会**把原文塞回模型可见的对话里。它的作用是把原文导出成文件，再让模型用 `read` 去看。这一点工具描述里已明确写出。

---

## 配置项

官方 11 个键原样生效（`thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` / `summarizationProvider` / `summarizationModel` / `maxTokens` / `compactionRetries` / `maxOverflowRetries` / `modelPolicies` / `auto`），由官方 resolver 校验，未知键仍被拒绝。

本插件新增 3 个键：

| 键 | 默认 | 说明 |
|---|---|---|
| `retentionInstructions` | `[]` | 追加到摘要指令的逐字保留规则，每条一个字符串 |
| `incremental` | `true` | 分层增量摘要开关 |
| `summaryLanguage` | `"auto"` | `"auto"` / `"zh"` / `"en"`，`auto` 按对话主语言判定 |

### 阈值是怎么算的

```
thresholdTokens = floor(min(contextWindow × thresholdRatio, messageBudget − headroomTokens))
```

官方默认 `thresholdRatio 0.8` + `headroomTokens 65536`，即占满约 80% 才压缩。

**可复现证据**：`test/trigger-threshold.test.mjs` 用官方 `compactIfNeeded('pressure')` 全机制在固定 46.9% 占用下实测 —— 官方默认 `0.8` 不触发（返回 `null`、摘要器零调用）；下调到 `0.35` 同一占用立即触发并提交完整官方事务（`compaction/start` → `compaction/summary` → `compaction/end` 无 error）。

---

## 兼容性

- **宿主**：DSH `0.2.0-rc.2`。`peerDependencies` 对 `@deepseek-ai/dsh*` 写**精确版本**（预发布排序下 `^0.2.0` 会被宿主兼容校验 deny）。

### 挂载范围：两类 preset，两种覆盖方式

压缩引擎有两处可能的位置，覆盖方式不同 —— **漏掉任何一类，那个 preset 下的会话就仍按官方 0.8 触发，表现像「设置没生效」**。

| preset | 位置 | 覆盖方式 |
|---|---|---|
| 官方 `standard` / `cordis` / `ptc` | DSH 安装树 `dsh-web-app/presets/` | profile 的 bundle patch 整行替换 config（`cordis.patch.yml`） |
| **用户自建** `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml` | 你的 home 目录 | **不走 patch 链**，需直接改写文件 |

`preset-minimal` 无 compaction 组，不需要覆盖。

自建 preset 必须显式同步一次，否则它里面的引擎仍是官方包：

```bash
node scripts/sync-custom-presets.mjs            # 只读扫描，列出待改写的 preset
node scripts/sync-custom-presets.mjs --apply    # 写入（原文件备份为 .bak-engine）
```

**每建一个新 preset、或每次 DSH 升级后，跑一次覆盖总览：**

```bash
node scripts/check-engine-coverage.mjs
```

它列出每个 preset 实际使用的引擎；`exit 1` 表示有 preset 未覆盖。只改 engine 行的 `name`，阈值仍以 `$DSH_HOME/context-compaction.json` 为单一真源。

### ⚠️ DSH 升级后必做

本插件用 bundle patch **整行替换 preset 的 config**（patch 语义是 config 整体赋值、绝不深合并），因此快照会随宿主升级腐化。

```bash
node scripts/verify-composition.mjs
```

**exit 1 表示结构已漂移**，此时需重拷快照并重新生成：

```bash
# 重拷 snapshots/<preset>.patch.yml 为最新官方原文
node scripts/generate-patch.mjs
node scripts/verify-composition.mjs   # 应为 exit 0
```

---

## 开发

```bash
pnpm run typecheck     # tsc --noEmit
pnpm run build         # tsc + 复制客户端 bundle 到 lib/
pnpm run check:client  # 离线加载客户端 bundle，校验导出与 slot 注册
pnpm test              # node --test（47 项）
pnpm run check         # 以上全部
```

### 目录结构

```
src/
  engine.ts              引擎：继承 BasicCompactionEngine，只覆写 summarize
  instruction.ts         摘要指令构造（保留规则 + 语言策略 + 增量模式）
  config.ts              插件级 3 个键的校验
  tools.ts               三个查询工具
  threshold-settings.ts  阈值模型（纯逻辑，无 IO，可离线测）
  settings-endpoint.ts   宿主半：/api/context-compaction 端点
  client/client.js       客户端半：设置页卡片（手写 __ModuleLoader__，无构建步骤）
scripts/
  generate-patch.mjs     从 snapshots/ 派生 cordis.patch.yml
  verify-composition.mjs 快照 vs 宿主结构比对（防腐化）
  sync-profile-patch.mjs 把生成的 preset 段同步进 profile patch
  add-root-row.mjs       把根层 Loader 行同步进 profile patch
  sync-custom-presets.mjs 把自建 preset 的引擎换成本插件
  check-engine-coverage.mjs 全量覆盖总览（官方 + 自建 preset）
  check-client-bundle.mjs 客户端 bundle 离线加载校验
snapshots/               官方 preset 原文快照（逐字保留）
```

### 两个设计要点

**为什么整行替换 preset 的 config？** 顶层行挂载无效，双重根因：patch 阶段 preset 内部行不在 Loader 的 id 索引里（`applyEntryPatches` 只在 `group:true` 时递归）；运行阶段 `isolate: {compaction: true}` 是 LocalRealm 私有 symbol，顶层 context 永远解析不到其服务。

**为什么设置卡片不走官方 config-editor？** 官方 `dsh-config-editor` 的 `entries()` 只接受父级为根 `include` 的条目（`lib/index.js` 中 `entry.parent.tree.ctx.fiber.entry?.id === "include"`），而引擎行嵌在 preset 内部，永远不可寻址。因此卡片自带 HTTP 端点与配置文件，照搬本机 `dsh-global-rules` 的成熟范式（`settings.section` slot + `connection.fetch.register`）。

---

## 已验证 / 未验证

**已执行验证（exit 0）**
- `pnpm run typecheck`、`pnpm run build`、`pnpm run check:client`
- `node --test`：**47/47 通过**
- 端点全链路：GET 默认 → POST 保存 → 落盘 → 非法值返 400
- 组合校验：`dsh --profile web --patch <patch> --dump-config` exit 0，三处替换正确落位
- 客户端 bundle 离线加载：bundle id / 双语字典 / `settings.section` 注册参数全部正确

**未验证（需真实运行环境）**
- 设置卡片在浏览器中的实际渲染与点击行为
- 真实会话中的压缩触发与真实 LLM 摘要流（测试使用 stub `ctx.llm.stream`）
- 摘要对保留规则的实际遵循度（规则已注入指令，模型是否照做未验）

---

## 许可

MIT。保留规则的文本采纳自 acp-kernel（MIT），仅规则文本，不含其运行时。
