/**
 * @file Guard the pi Flex adapter assets: ODW adapter command shapes, the
 * service-tier extension, and the Dakar-owned provider catalogue.
 *
 * These are cheap regression guards. The authoritative effective-configuration
 * evidence for `service_tier = "flex"` is the M0 capture-server and live-probe
 * transcripts recorded in the ExecPlan's "Artefacts and notes"; these tests only
 * assert that the committed adapter assets keep their load-bearing shape.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const odwConfig = JSON.parse(readFileSync(join(repoRoot, 'odw.config.json'), 'utf8'))
const models = JSON.parse(readFileSync(join(repoRoot, 'adapters', 'pi', 'models.json'), 'utf8'))
const extension = readFileSync(join(repoRoot, 'adapters', 'pi', 'flex-tier.ts'), 'utf8')

function commandOf(name) {
  const adapter = odwConfig.adapters[name]
  assert.ok(adapter, `odw.config.json must define the ${name} adapter`)
  assert.ok(Array.isArray(adapter.command), `${name} must carry a command array`)
  return adapter
}

test('odw.config.json still declares the legacy Codex adapters', () => {
  for (const name of ['codex-low', 'codex-medium', 'codex-high']) {
    assert.ok(odwConfig.adapters[name], `${name} must remain for legacy references`)
  }
})

test('pi Flex adapters pin print mode, provider, model, and thinking per lane', () => {
  const cases = [
    { name: 'pi-luna-flex', model: 'gpt-5.6-luna', thinking: 'low' },
    { name: 'pi-luna-flex-medium', model: 'gpt-5.6-luna', thinking: 'medium' },
    { name: 'pi-terra-flex', model: 'gpt-5.6-terra', thinking: 'medium' },
  ]
  for (const { name, model, thinking } of cases) {
    const adapter = commandOf(name)
    const command = adapter.command
    assert.equal(command[0], 'pi', `${name} must invoke pi`)
    assert.ok(command.includes('-p'), `${name} must use pi print mode`)
    assert.ok(command.includes('--no-session'), `${name} must disable session persistence`)
    const providerIndex = command.indexOf('--provider')
    assert.equal(command[providerIndex + 1], 'openai-flex', `${name} must pin the openai-flex provider`)
    const extensionIndex = command.indexOf('-e')
    assert.ok(extensionIndex !== -1, `${name} must load the flex-tier extension`)
    assert.match(command[extensionIndex + 1], /flex-tier\.ts$/u, `${name} must reference flex-tier.ts`)
    const modelIndex = command.indexOf('--model')
    assert.equal(command[modelIndex + 1], model, `${name} must pin ${model}`)
    const thinkingIndex = command.indexOf('--thinking')
    assert.equal(command[thinkingIndex + 1], thinking, `${name} must pin ${thinking} thinking`)
    assert.equal(adapter.stdin, '{prompt}', `${name} must read the prompt from stdin`)
  }
})

test('flex-tier extension injects the Flex service tier and logs usage to stderr', () => {
  assert.match(extension, /service_tier:\s*'flex'/u, 'the extension must inject service_tier: flex')
  assert.match(extension, /before_provider_request/u, 'the extension must hook before_provider_request')
  assert.match(extension, /DAKAR-USAGE:/u, 'the extension must emit the DAKAR-USAGE stderr marker')
  assert.match(extension, /console\.error/u, 'the DAKAR-USAGE marker must be written to stderr')
})

test('models.json declares both Flex models under the openai-flex provider', () => {
  const provider = models.providers['openai-flex']
  assert.ok(provider, 'models.json must declare the openai-flex provider')
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1')
  assert.equal(provider.api, 'openai-responses')
  assert.equal(provider.apiKey, '$OPENAI_API_KEY')
  assert.ok(Array.isArray(provider.models), 'pi requires models to be an array of { id } entries')
  const byId = new Map(provider.models.map((model) => [model.id, model]))
  assert.ok(byId.get('gpt-5.6-luna'), 'openai-flex must declare gpt-5.6-luna')
  assert.ok(byId.get('gpt-5.6-terra'), 'openai-flex must declare gpt-5.6-terra')
  assert.equal(byId.get('gpt-5.6-luna').reasoning, true)
  assert.equal(byId.get('gpt-5.6-terra').reasoning, true)
})
