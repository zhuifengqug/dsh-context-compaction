#!/usr/bin/env node
/**
 * add-root-row.mjs — 把插件 patch 的根层 `- insert:` 行同步进 profile patch。
 *
 * 为什么必须这样做：DSH 的客户端模块系统按 Loader 行发现包的客户端半，
 * 遍历的是根 Include 下的行。只把 name 写进 preset 内部，客户端加载器
 * 遍历根层时遇不到本包，dsh.client 形同不存在（设置项不出现的根因）。
 *
 * 幂等：若 profile patch 里已存在本插件的根层行则跳过。
 *
 * 用法：node scripts/add-root-row.mjs [--profile <path>]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = join(ROOT, 'cordis.patch.yml')

const argIdx = process.argv.indexOf('--profile')
const PROFILE = argIdx >= 0 && process.argv[argIdx + 1]
  ? process.argv[argIdx + 1]
  : 'D:/DSHData/home/profiles/desktop/cordis.patch.yml'

const MARKER = "@gjs27/dsh-context-compaction"

if (!existsSync(SOURCE)) throw new Error(`插件 patch 不存在: ${SOURCE}`)
if (!existsSync(PROFILE)) throw new Error(`profile patch 不存在: ${PROFILE}`)

const sourceLines = readFileSync(SOURCE, 'utf8').split(/\r?\n/)
const insertStart = sourceLines.findIndex((line) => line === '- insert:')
if (insertStart < 0) throw new Error('插件 patch 里找不到根层 `- insert:` 行')

// 收集这一行块：从 `- insert:` 到下一个顶层条目（- id: / - insert:）或空行块结束。
let insertEnd = insertStart + 1
while (insertEnd < sourceLines.length && /^\s{2,}/.test(sourceLines[insertEnd])) insertEnd += 1
const block = sourceLines.slice(insertStart, insertEnd)
if (!block.some((line) => line.includes(MARKER))) {
  throw new Error('根层行块里没有本插件的包名，拒绝写入')
}

const profileText = readFileSync(PROFILE, 'utf8')
const profileLines = profileText.split(/\r?\n/)

// 幂等：已经插入过就直接退出。
const already = profileLines.some((line, i) =>
  line.includes(MARKER) && /^\s{4}- id:/.test(profileLines[i - 1] ?? '') === false &&
  profileLines.slice(Math.max(0, i - 2), i).some((prev) => prev.trim() === '- insert:'))
if (already) {
  console.log('profile patch 已存在根层行，跳过')
  process.exit(0)
}

// 插到第一个 `- id: preset-` 之前；没有则追加到末尾。
const anchor = profileLines.findIndex((line) => /^- id: preset-/.test(line))
const at = anchor >= 0 ? anchor : profileLines.length
console.log(`插入位置：${anchor >= 0 ? `L${at + 1}（${profileLines[at]} 之前）` : '文件末尾'}`)

const merged = [...profileLines.slice(0, at), ...block, '', ...profileLines.slice(at)]
copyFileSync(PROFILE, `${PROFILE}.bak-rootrow`)
writeFileSync(PROFILE, merged.join('\n'), 'utf8')
console.log(`已写入 ${PROFILE}（备份 ${PROFILE}.bak-rootrow）`)
console.log(`插入 ${block.length} 行：`)
for (const line of block) console.log(`  ${line}`)
