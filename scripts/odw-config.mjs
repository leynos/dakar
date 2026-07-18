/**
 * @file Derive a per-run ODW adapter configuration that bounds the pi Flex calls.
 *
 * The packaged `odw.config.json` declares the adapters but leaves each call
 * unbounded. The `--per-call-timeout` CLI option (default 300 s) must actually
 * bound the model calls, so the CLI stamps the ODW-native `timeout` key (seconds)
 * onto exactly the three pi Flex adapters before every run. A timed-out adapter
 * surfaces as a catchable thrown error the workflow's retry classifier already
 * handles, so no workflow change is needed. The Codex adapters are left
 * untouched. The derivation is a pure function so it can be unit-tested away from
 * the CLI's process side effects.
 */

/** The pi Flex adapters whose model calls the per-call timeout must bound. */
export const PI_FLEX_ADAPTERS = Object.freeze(['pi-luna-flex', 'pi-luna-flex-medium', 'pi-terra-flex'])

/**
 * Stamp the per-call timeout onto the pi Flex adapters of an ODW config.
 *
 * The base config is deep-copied so the packaged config object is never mutated;
 * only the three pi Flex adapters gain a `timeout` (in seconds) and every other
 * adapter is copied byte-for-byte.
 *
 * @param {object} baseConfigJson - the parsed packaged ODW config.
 * @param {number} perCallTimeoutSeconds - per-model-call timeout in seconds.
 * @returns {object} a new config with the pi Flex adapters carrying the timeout.
 */
export function deriveOdwConfig(baseConfigJson, perCallTimeoutSeconds) {
  const derived = structuredClone(baseConfigJson)
  const adapters = derived.adapters || {}
  for (const name of PI_FLEX_ADAPTERS) {
    if (adapters[name]) {
      adapters[name] = { ...adapters[name], timeout: perCallTimeoutSeconds }
    }
  }
  derived.adapters = adapters
  return derived
}
