/**
 * Copy the hand-written client bundle from src/client into lib, where the
 * package's "./client" export and the Harness client loader resolve it.
 *
 * The bundle is not TypeScript — it is a __ModuleLoader__ factory that runs in
 * the browser, where the loader's module table provides `react`. tsc neither
 * compiles nor copies it, so the build step copies it verbatim.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src', 'client', 'client.js')
const target = join(root, 'lib', 'client.js')

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`copied ${source} -> ${target}`)
