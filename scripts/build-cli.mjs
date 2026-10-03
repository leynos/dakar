/**
 * Build the Node-loadable CLI entry point from its source and local modules.
 *
 * The installable bundle keeps Node from needing to strip TypeScript inside
 * `node_modules`, while leaving source execution and workflow bundling intact.
 *
 * @module
 */

import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ENTRY = path.join(ROOT, 'bin', 'dakar-review.mjs')
const OUTPUT = path.join(ROOT, 'bin', 'dakar-review.bundle.mjs')
const EXTERNAL_MODULES = [
  '../scripts/deterministic-gates.mjs',
  '../scripts/odw-config.mjs',
  '../scripts/review-config.mjs',
  '../scripts/review-state.mjs',
]
const BANNER = `/**
 * Generated Node-loadable Dakar CLI bundle.
 *
 * Built by \`npm run cli:build\` from bin/dakar-review.mjs and local runtime
 * modules. Do not edit directly.
 *
 * @module
 */`

const checkOnly = process.argv.includes('--check')
const result = await build({
  banner: { js: BANNER },
  bundle: true,
  entryPoints: [ENTRY],
  external: EXTERNAL_MODULES,
  format: 'esm',
  legalComments: 'inline',
  logLevel: 'silent',
  outfile: OUTPUT,
  platform: 'node',
  write: false,
})
const generated = result.outputFiles[0].text.replace(/\r\n?/gu, '\n')

if (checkOnly) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => null)
  if (current !== generated) {
    process.stderr.write('bin/dakar-review.bundle.mjs is stale; run `npm run cli:build`.\n')
    process.exitCode = 1
  }
} else {
  await writeFile(OUTPUT, generated)
  await chmod(OUTPUT, 0o755)
  process.stdout.write(`bin/dakar-review.bundle.mjs: built (${Buffer.byteLength(generated)} bytes)\n`)
}
