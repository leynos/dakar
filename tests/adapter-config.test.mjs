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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import flexTier from '../adapters/pi/extensions/flex-tier.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const odwConfig = JSON.parse(readFileSync(join(repoRoot, 'odw.config.json'), 'utf8'))
const models = JSON.parse(readFileSync(join(repoRoot, 'adapters', 'pi', 'models.json'), 'utf8'))

function registerFlexHooks() {
  const hooks = new Map()
  flexTier({ on: (eventName, callback) => hooks.set(eventName, callback) })
  return hooks
}

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
    // The extension auto-loads from PI_CODING_AGENT_DIR/extensions/ (set
    // absolutely by the CLI), so a cwd-fragile relative -e flag must NOT
    // appear in the command (observed live, M7).
    assert.equal(command.indexOf('-e'), -1, `${name} must not carry a relative -e extension flag`)
    const modelIndex = command.indexOf('--model')
    assert.equal(command[modelIndex + 1], model, `${name} must pin ${model}`)
    const thinkingIndex = command.indexOf('--thinking')
    assert.equal(command[thinkingIndex + 1], thinking, `${name} must pin ${thinking} thinking`)
    assert.equal(adapter.stdin, '{prompt}', `${name} must read the prompt from stdin`)
  }
})

test('flex-tier extension injects Flex and reports assistant usage', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-flex-tier-'))
  const usageLog = join(tempRoot, 'usage.jsonl')
  const previousUsageLog = process.env.DAKAR_USAGE_LOG
  const previousConsoleError = console.error
  const stderrRecords = []
  try {
    process.env.DAKAR_USAGE_LOG = usageLog
    console.error = (...parts) => stderrRecords.push(parts.join(' '))
    const hooks = registerFlexHooks()

    const providerPayload = { model: 'gpt-5.6-luna', stream: true, custom: { keep: 'me' } }
    assert.deepEqual(hooks.get('before_provider_request')({ payload: providerPayload }), {
      ...providerPayload,
      service_tier: 'flex',
    })

    const record = {
      model: 'gpt-5.6-luna',
      usage: { input: 13, output: 5, cacheRead: 3, cacheWrite: 2 },
    }
    hooks.get('message_end')({ message: { role: 'assistant', ...record } })
    hooks.get('message_end')({ message: { role: 'user', content: 'not telemetry' } })

    assert.equal(stderrRecords.length, 1)
    assert.match(stderrRecords[0], /^DAKAR-USAGE: /u)
    const stderrRecord = JSON.parse(stderrRecords[0].slice('DAKAR-USAGE: '.length))
    assert.deepEqual(stderrRecord, record)
    const fileRecords = readFileSync(usageLog, 'utf8').trimEnd().split('\n')
    assert.equal(fileRecords.length, 1)
    assert.deepEqual(JSON.parse(fileRecords[0]), stderrRecord)
  } finally {
    if (previousUsageLog === undefined) delete process.env.DAKAR_USAGE_LOG
    else process.env.DAKAR_USAGE_LOG = previousUsageLog
    console.error = previousConsoleError
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('flex-tier telemetry append failure does not interrupt the review', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dakar-flex-tier-failure-'))
  const previousUsageLog = process.env.DAKAR_USAGE_LOG
  const previousConsoleError = console.error
  const stderrRecords = []
  try {
    process.env.DAKAR_USAGE_LOG = tempRoot
    console.error = (...parts) => stderrRecords.push(parts.join(' '))
    const messageEnd = registerFlexHooks().get('message_end')

    assert.doesNotThrow(() =>
      messageEnd({
        message: { role: 'assistant', model: 'gpt-5.6-terra', usage: { input: 8, output: 2 } },
      }),
    )
    assert.equal(stderrRecords.length, 1)
    assert.match(stderrRecords[0], /^DAKAR-USAGE: /u)
  } finally {
    if (previousUsageLog === undefined) delete process.env.DAKAR_USAGE_LOG
    else process.env.DAKAR_USAGE_LOG = previousUsageLog
    console.error = previousConsoleError
    rmSync(tempRoot, { recursive: true, force: true })
  }
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
