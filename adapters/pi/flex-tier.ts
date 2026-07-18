/**
 * @file Dakar-owned pi extension that selects OpenAI Flex processing.
 *
 * ADR 002 requires every default model call to bill at Flex rather than
 * standard rates. Codex CLI cannot transmit `service_tier` (see the M0
 * observations in the api-key-support ExecPlan), so Dakar routes model work
 * through the `pi` coding agent and injects the tier here, at pi's documented
 * `before_provider_request` hook. The `message_end` hook echoes the provider's
 * reported usage to stderr with a `DAKAR-USAGE:` marker so the Dakar harness
 * can recover per-call token counts that print mode does not otherwise surface.
 *
 * The host, not this extension or any prompt, selects the model and lane; this
 * extension only stamps the service tier and reports usage.
 */

/**
 * Registers the Flex service-tier and usage-reporting hooks on a pi instance.
 *
 * @param pi - The pi extension host exposing the event hook registration API.
 */
export default function flexTier(pi) {
  pi.on('before_provider_request', (event) => ({ ...event.payload, service_tier: 'flex' }))
  pi.on('message_end', (event) => {
    if (event.message?.role === 'assistant') {
      console.error('DAKAR-USAGE: ' + JSON.stringify(event.message.usage))
    }
  })
}
