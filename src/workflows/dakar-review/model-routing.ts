/**
 * Resolve review roles, reasoning levels, adapters, and model names.
 *
 * @module
 */

import * as z from 'zod'
import type { ModelSpec, Reasoning } from './types.ts'

const modelNameInputSchema = z.union([
  z.string().transform((model) => ({ model, reasoning: 'default' })),
  z.object({ model: z.string(), reasoning: z.string().optional() }),
])
const flexLaneRoleSchema = z.enum(['luna', 'luna-medium', 'luna-low', 'terra'])

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
  const parsed = modelNameInputSchema.safeParse(spec)
  if (!parsed.success) throw new TypeError('model spec must contain a non-empty model string')
  const model = parsed.data.model
  if (model.length === 0) {
    throw new TypeError('model spec must contain a non-empty model string')
  }
  return model.includes('/') ? model : `${model}/${parsed.data.reasoning || 'default'}`
}

/**
 * Removes the optional reasoning suffix from a model identifier.
 *
 * @param model - Model identifier, optionally followed by `/reasoning`.
 * @returns The base model segment before the first slash.
 */
export function baseModel(model: string): string {
  return model.split('/')[0] ?? ''
}

/**
 * Reads a reasoning suffix from a model identifier.
 *
 * @param model - Model identifier, optionally followed by `/reasoning`.
 * @param fallback - Reasoning value to use when the identifier has no suffix.
 * @returns The explicit suffix or the supplied fallback.
 */
export function reasoningFromModel(model: string, fallback: string): string {
  return model.split('/')[1] || fallback
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
export function isReasoning(value: string): value is Reasoning {
  return value === 'low' || value === 'medium' || value === 'high'
}

/** Luna Flex roles the finder-plan builder accepts. */
export type LunaFlexLaneRole = 'luna' | 'luna-medium' | 'luna-low'

/**
 * Select the registered Luna Flex lane for a reasoning value.
 *
 * @param reasoning - Resolved or untrusted reasoning value.
 * @returns The high lane by default, or the matching de-escalation lane.
 */
export function lunaFlexLaneRole(reasoning: string): LunaFlexLaneRole {
  if (reasoning === 'medium') return 'luna-medium'
  if (reasoning === 'low') return 'luna-low'
  return 'luna'
}
/** Pins one Flex execution lane to its model, adapter, service tier, and effort. */
export interface FlexLaneSpec {
  /** Logical Flex lane role that selects this pinned specification. */
  role: string
  /** Host-selected model identifier for the lane. */
  model: string
  /** Provider-independent (pi) adapter that dispatches the lane's requests. */
  adapter: string
  /** Service tier for the lane, always the Flex tier. */
  serviceTier: 'flex'
  /** Reasoning effort applied to the lane's requests. */
  reasoning: Reasoning
}

/** Named lanes available to the host-controlled Flex router. */
export interface FlexLaneRegistry {
  /** Default high-reasoning Luna finder lane. */
  readonly luna: Readonly<FlexLaneSpec>
  /** Medium-reasoning Luna finder fallback. */
  readonly 'luna-medium': Readonly<FlexLaneSpec>
  /** Low-reasoning Luna finder fallback. */
  readonly 'luna-low': Readonly<FlexLaneSpec>
  /** High-reasoning Terra audit lane. */
  readonly terra: Readonly<FlexLaneSpec>
}

/**
 * Maps each Flex lane role to its host-selected model and pi adapter. The host,
 * not an agent prompt, chooses the lane; agents cannot promote themselves to a
 * more expensive model or service tier (ADR 002). The default `luna` and
 * `terra` lanes run at high reasoning since the 2026-08-13 Flex repricing;
 * `luna-medium` and `luna-low` are the pre-registered de-escalation lanes for
 * the Luna finder.
 */
export const FLEX_LANE_ROLES: Readonly<FlexLaneRegistry> = Object.freeze({
  luna: Object.freeze({ role: 'luna', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex-high', serviceTier: 'flex', reasoning: 'high' }),
  'luna-medium': Object.freeze({ role: 'luna-medium', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex-medium', serviceTier: 'flex', reasoning: 'medium' }),
  'luna-low': Object.freeze({ role: 'luna-low', model: 'gpt-5.6-luna', adapter: 'pi-luna-flex', serviceTier: 'flex', reasoning: 'low' }),
  terra: Object.freeze({ role: 'terra', model: 'gpt-5.6-terra', adapter: 'pi-terra-flex-high', serviceTier: 'flex', reasoning: 'high' }),
})

/**
 * Resolves a Flex lane role to its pinned lane specification.
 *
 * @param role - One of `luna`, `luna-medium`, `luna-low`, or `terra`.
 * @returns The frozen lane specification for that role.
 * @throws {Error} When the role is not a registered Flex lane.
 */
export function flexLaneRole(role: string): Readonly<FlexLaneSpec> {
  const parsed = flexLaneRoleSchema.safeParse(role)
  if (!parsed.success) throw new Error(`unknown flex lane role: ${role}`)
  return FLEX_LANE_ROLES[parsed.data]
}
