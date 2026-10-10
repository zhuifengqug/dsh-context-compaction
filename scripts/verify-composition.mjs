#!/usr/bin/env node
/**
 * verify-composition.mjs — preset 快照防腐化校验（t1 高风险项 R1）
 *
 * 背景：本插件的挂载方案是「profile 层整行替换 preset-* 的 config」。
 * patch 引擎对匹配到的行是**整行替换 config、绝不深合并**（dsh-app-boot
 * L104-107）。因此只要官方 preset 结构发生任何变化（DSH 升级新增/删除/
 * 改名插件行、调整 isolate 映射、改动 compaction 组），我们持有的快照就会
 * 继续按旧结构覆盖新版本 → **静默丢失新行**，且没有任何报错。
 *
 * 本脚本把「快照 vs 当前宿主」的差异显式暴露出来，供升级后与交付前运行。
 *
 * 用法：
 *   node scripts/verify-composition.mjs                 # 对比并报告
 *   node scripts/verify-composition.mjs --json          # 机器可读输出
 *   node scripts/verify-composition.mjs --host <dir>    # 指定宿主 presets 目录
 *
 * 退出码：0=一致；1=有差异（快照已腐化，必须重做）；2=环境/参数错误。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = join(HERE, '..', 'snapshots')

/** 覆盖范围内的 preset（t1 裁定：standard + cordis + ptc；minimal 无 compaction 组）。 */
const COVERED = ['standard', 'cordis', 'ptc']
/** 仅作基线留档、不参与替换的 preset。 */
const BASELINE_ONLY = ['minimal']

const DEFAULT_HOST = 'D:\\Deepseek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-web-app\\presets'

function parseArgs(argv) {
  const out = { json: false, host: DEFAULT_HOST }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--host') { out.host = argv[i + 1]; i += 1 }
  }
  return out
}

/**
 * 从 preset 文件中抽取「结构性事实」：config.id/order 与每个插件行的
 * id/name/disabled/group/isolate 键。只做浅层行解析，不引入 YAML 依赖，
 * 目的是检测结构漂移而非逐字比对（逐字比对会因注释与空白误报）。
 */
function structureOf(text) {
  const lines = text.split(/\r?\n/)
  const facts = { configId: null, order: null, rows: [], isolateKeys: [] }
  let insidePlugins = false
  let pluginsIndent = -1
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    const idMatch = /^id:\s*(.+)$/.exec(trimmed)
    if (idMatch && indent <= 8 && facts.configId === null) {
      facts.configId = idMatch[1].trim()
      continue
    }
    const orderMatch = /^order:\s*(.+)$/.exec(trimmed)
    if (orderMatch && facts.order === null) { facts.order = orderMatch[1].trim(); continue }

    if (/^plugins:\s*$/.test(trimmed)) { insidePlugins = true; pluginsIndent = indent; continue }
    if (!insidePlugins) continue
    if (indent <= pluginsIndent) { insidePlugins = false; continue }

    // 顶层插件行（- id: xxx），缩进比 plugins 深一层
    const rowId = /^-\s+id:\s*(.+)$/.exec(trimmed)
    if (rowId && indent === pluginsIndent + 2) { facts.rows.push({ id: rowId[1].trim(), group: false, isolate: [] }); continue }
    // 组行（name: cordis:group 紧跟其后）
    if (/^name:\s*cordis:group\s*$/.test(trimmed) && facts.rows.length > 0) {
      facts.rows[facts.rows.length - 1].group = true
      continue
    }
    const isolateKey = /^([A-Za-z_][A-Za-z0-9_]*):\s*true\s*$/.exec(trimmed)
    if (isolateKey && facts.rows.length > 0) facts.rows[facts.rows.length - 1].isolate.push(isolateKey[1])
  }
  return facts
}

function diffFacts(snap, host) {
  const issues = []
  if (snap.configId !== host.configId) issues.push(`config.id: 快照=${snap.configId} 宿主=${host.configId}`)
  if (snap.order !== host.order) issues.push(`config.order: 快照=${snap.order} 宿主=${host.order}`)
  const sIds = snap.rows.map((r) => r.id)
  const hIds = host.rows.map((r) => r.id)
  const missing = hIds.filter((id) => !sIds.includes(id))
  const extra = sIds.filter((id) => !hIds.includes(id))
  if (missing.length) issues.push(`宿主新增/快照缺失的插件行: ${missing.join(', ')}`)
  if (extra.length) issues.push(`快照多出/宿主已删除的插件行: ${extra.join(', ')}`)
  // 同 position 顺序漂移
  if (missing.length === 0 && extra.length === 0 && sIds.join('|') !== hIds.join('|')) {
    issues.push('插件行顺序发生变化（顺序漂移）')
  }
  for (const hRow of host.rows) {
    const sRow = snap.rows.find((r) => r.id === hRow.id)
    if (!sRow) continue
    if (sRow.group !== hRow.group) issues.push(`行 ${hRow.id}: group 标志变化（快照=${sRow.group} 宿主=${hRow.group}）`)
    const si = [...sRow.isolate].sort().join(',')
    const hi = [...hRow.isolate].sort().join(',')
    if (si !== hi) issues.push(`行 ${hRow.id}: isolate 键变化（快照=[${si}] 宿主=[${hi}]）`)
  }
  // compaction 组必须存在且含 engine 行 + pruner
  const hasCompaction = host.rows.some((r) => r.id === 'compaction')
  if (!hasCompaction) issues.push('宿主缺少 compaction 组——替换目标消失')
  return issues
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = { host: args.host, generatedAt: new Date().toISOString(), presets: {}, drift: [] }

  if (!existsSync(args.host)) {
    console.error(`[verify-composition] 宿主 presets 目录不存在: ${args.host}`)
    console.error('  若 DSH 安装位置变化，请用 --host <dir> 指定。')
    process.exit(2)
  }

  for (const name of [...COVERED, ...BASELINE_ONLY]) {
    const snapPath = join(SNAPSHOT_DIR, `${name}.patch.yml`)
    const hostPath = join(args.host, `${name}.patch.yml`)
    if (!existsSync(snapPath)) { report.drift.push(`${name}: 快照文件缺失`); continue }
    if (!existsSync(hostPath)) { report.drift.push(`${name}: 宿主文件缺失（该 preset 可能已被移除）`); continue }

    const snapFacts = structureOf(readFileSync(snapPath, 'utf8'))
    const hostFacts = structureOf(readFileSync(hostPath, 'utf8'))
    const issues = diffFacts(snapFacts, hostFacts)
    report.presets[name] = {
      covered: COVERED.includes(name),
      configId: hostFacts.configId,
      order: hostFacts.order,
      rowCount: hostFacts.rows.length,
      compactionGroup: hostFacts.rows.some((r) => r.id === 'compaction'),
      issues,
    }
    if (issues.length > 0 && COVERED.includes(name)) {
      report.drift.push(`${name}: ${issues.length} 项结构漂移`)
    }
  }

  if (args.json) { console.log(JSON.stringify(report, null, 2)) }
  else {
    console.log('=== preset 快照防腐化校验 ===')
    console.log(`宿主: ${report.host}`)
    for (const [name, info] of Object.entries(report.presets)) {
      const tag = info.covered ? '[覆盖]' : '[仅基线]'
      console.log(`\n${tag} ${name}: config.id=${info.configId} order=${info.order} 顶层行=${info.rowCount} compaction组=${info.compactionGroup}`)
      if (info.issues.length === 0) console.log('  ✓ 与快照结构一致')
      else for (const i of info.issues) console.log(`  ✗ ${i}`)
    }
    if (report.drift.length > 0) {
      console.log('\n!!! 快照已腐化，必须重做 !!!')
      for (const d of report.drift) console.log(`  - ${d}`)
      console.log('\npatch 语义是整行替换 config、绝不深合并：继续用旧快照会静默丢失宿主新行。')
      console.log('处置：重新拷贝当前宿主 preset 到 snapshots/，并按新结构重述替换体。')
    } else {
      console.log('\n✓ 全部覆盖范围内 preset 与快照结构一致。')
    }
  }
  process.exit(report.drift.length > 0 ? 1 : 0)
}

main()
