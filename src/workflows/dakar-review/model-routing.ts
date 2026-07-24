/** @file Resolve review roles, reasoning levels, adapters, and model names. */

import type { ModelSpec, Reasoning } from './types.ts'

/** Provides the immutable default model assignment for each review role. */
export const DEFAULT_REVIEW_MODELS: readonly Readonly<ModelSpec>[] = Object.freeze([
  Object.freeze({ label: 'codex-medium', model: 'gpt-5.5', reasoning: 'medium', role: 'medium' }),
  Object.freeze({ label: 'codex-high', model: 'gpt-5.5', reasoning: 'high', role: 'high' }),
  Object.freeze({ label: 'codex-mini', model: 'gpt-5.4-mini', reasoning: 'medium', role: 'mini' }),
  Object.freeze({ label: 'codex-spark', model: 'gpt-5.3-codex-spark', reasoning: 'medium', role: 'spark' }),
])

/**
 * Formats a model specification as the adapter-facing model/reasoning name.
 *
 * @param spec - A model identifier or typed specification with optional reasoning suffix.
 * @returns The existing suffixed identifier or one with its configured/default reasoning.
 * @throws {TypeError} When an object specification has no non-empty model identifier.
 */
export function modelName(spec: ModelSpec | string): string {
  const model = typeof spec === 'string' ? spec : spec.model
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model spec must contain a non-empty model string')
  }
  return model.includes('/') ? model : `${model}/${typeof spec === 'string' ? 'default' : spec.reasoning || 'default'}`
}

/**
 * Removes the optional reasoning suffix from a model identifier.
 *
 * @param model - Model identifier, optionally followed by `/reasoning`.
 * @returns The base model segment before the first slash.
 */
export function baseModel(model: string): string {
  return String(model).split('/')[0] ?? ''
}

/**
 * Reads a reasoning suffix from a model identifier.
 *
 * @param model - Model identifier, optionally followed by `/reasoning`.
 * @param fallback - Reasoning value to use when the identifier has no suffix.
 * @returns The explicit suffix or the supplied fallback.
 */
export function reasoningFromModel(model: string, fallback: string): string {
  return String(model).split('/')[1] || fallback
}

/**
 * Selects the supported Codex adapter for a reasoning level.
 *
 * @param reasoning - Requested reasoning level; unsupported values use medium.
 * @returns A `codex-low`, `codex-medium`, or `codex-high` adapter name.
 */
export function adapterForReasoning(reasoning: string): string {
  return ['low', 'medium', 'high'].includes(reasoning) ? `codex-${reasoning}` : 'codex-medium'
}

/**
 * Selects the first configured model assigned to a review role.
 *
 * @param role - Logical review role to match.
 * @param reviewModels - Ordered model specifications used as role and fallback choices.
 * @returns The matching model, first configured model, or closed built-in fallback.
 */
export function modelForRole(role: string, reviewModels: readonly Readonly<ModelSpec>[]): Readonly<ModelSpec> {
  return reviewModels.find((spec) => spec.role === role) || reviewModels[0] || { model: 'gpt-5.5', reasoning: 'high' }
}

/**
 * Narrows an untrusted value to a supported reasoning level.
 *
 * @param value - External value to test.
 * @returns Whether the value is `low`, `medium`, or `high`.
 */
export function isReasoning(value: unknown): value is Reasoning {
  return value === 'low' || value === 'medium' || value === 'high'
}

/** Pins one Flex execution lane to its model, adapter, service tier, and effort. */
export interface FlexLaneSpec {
  role: string
  model: string
  adapter: string
  serviceTier: 'flex'
  reasoning: Reasoning
}

/**
 * Maps each Flex lane role to its host-selected model and pi adapter. The host,
 * not an agent prompt, chooses the lane; agents cannot promote themselves to a
 * more expensive model or service tier (ADR 002). `luna-medium` is the
 * pre-registered escalation lane for the Luna finder.
 */
export const FLEX_LANE_ROLES: Readonly<Record<'luna' | 'luna-medium' | 'terra', Readonly<FlexLaneSpec>>> = Object.freeze({
  luna: Object.freeze({ role: 'luna', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex', serviceTier: 'flex', reasoning: 'low' }),
  'luna-medium': Object.freeze({ role: 'luna-medium', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex-medium', serviceTier: 'flex', reasoning: 'medium' }),
  terra: Object.freeze({ role: 'terra', model: 'gpt-5.6-terra', adapter: 'pi-terra-flex', serviceTier: 'flex', reasoning: 'medium' }),
})

/**
 * Resolves a Flex lane role to its pinned lane specification.
 *
 * @param role - One of `luna`, `luna-medium`, or `terra`.
 * @returns The frozen lane specification for that role.
 * @throws {Error} When the role is not a registered Flex lane.
 */
export function flexLaneRole(role: string): Readonly<FlexLaneSpec> {
  const spec = (FLEX_LANE_ROLES as Record<string, Readonly<FlexLaneSpec>>)[role]
  if (spec === undefined) throw new Error(`unknown flex lane role: ${role}`)
  return spec
}
