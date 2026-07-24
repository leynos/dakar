/**
 * @file Dakar-owned pi extension that selects OpenAI Flex processing.
 *
 * ADR 002 requires every default model call to bill at Flex rather than
 * standard rates. Codex CLI cannot transmit `service_tier` (see the M0
 * observations in the api-key-support ExecPlan), so Dakar routes model work
 * through the `pi` coding agent and injects the tier here, at pi's documented
 * `before_provider_request` hook.
 *
 * The `message_end` hook reports the provider's usage twice: to stderr with a
 * `DAKAR-USAGE:` marker (human-inspectable), and — when the host sets the
 * `DAKAR_USAGE_LOG` environment variable — appended as a JSON line to that
 * file, because the ODW runtime does not forward adapter stderr (observed
 * live, M7). Each line carries the model so the host can price the usage
 * per lane.
 *
 * The host, not this extension or any prompt, selects the model and lane; this
 * extension only stamps the service tier and reports usage.
 */

import { appendFileSync } from 'node:fs'

/**
 * Registers the Flex service-tier and usage-reporting hooks on a pi instance.
 *
 * @param pi - The pi extension host exposing the event hook registration API.
 */
export default function flexTier(pi) {
  pi.on('before_provider_request', (event) => ({ ...event.payload, service_tier: 'flex' }))
  pi.on('message_end', (event) => {
    if (event.message?.role !== 'assistant') return
    const record = { model: event.message.model, usage: event.message.usage }
    console.error('DAKAR-USAGE: ' + JSON.stringify(record))
    const usageLog = process.env.DAKAR_USAGE_LOG
    if (usageLog) {
      try {
        appendFileSync(usageLog, JSON.stringify(record) + '\n')
      } catch {
        // Usage reporting must never break the review call itself.
      }
    }
  })
}
