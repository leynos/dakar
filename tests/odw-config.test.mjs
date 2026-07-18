/** @file Unit-test the per-run ODW config derivation that stamps the Flex timeout. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { deriveOdwConfig } from '../scripts/odw-config.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packaged = JSON.parse(readFileSync(join(repoRoot, 'odw.config.json'), 'utf8'))

test('deriveOdwConfig stamps the timeout on exactly the pi Flex adapters', () => {
  const derived = deriveOdwConfig(packaged, 300)
  for (const name of ['pi-luna-flex', 'pi-luna-flex-medium', 'pi-terra-flex']) {
    assert.equal(derived.adapters[name].timeout, 300, `${name} must carry the per-call timeout`)
  }
  for (const name of ['codex-low', 'codex-medium', 'codex-high']) {
    assert.equal('timeout' in derived.adapters[name], false, `${name} must stay untouched`)
    assert.deepEqual(derived.adapters[name], packaged.adapters[name], `${name} must be byte-identical`)
  }
})

test('deriveOdwConfig honours a non-default timeout value', () => {
  const derived = deriveOdwConfig(packaged, 120)
  for (const name of ['pi-luna-flex', 'pi-luna-flex-medium', 'pi-terra-flex']) {
    assert.equal(derived.adapters[name].timeout, 120, `${name} must carry the supplied timeout`)
  }
})

test('deriveOdwConfig leaves the base config unmutated', () => {
  const before = JSON.stringify(packaged)
  deriveOdwConfig(packaged, 120)
  assert.equal(JSON.stringify(packaged), before, 'the base config must not be mutated in place')
})
