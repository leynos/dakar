import type { ModelSpec, Reasoning } from './types.ts'

export const DEFAULT_REVIEW_MODELS: readonly Readonly<ModelSpec>[] = Object.freeze([
  Object.freeze({ label: 'codex-medium', model: 'gpt-5.5', reasoning: 'medium', role: 'medium' }),
  Object.freeze({ label: 'codex-high', model: 'gpt-5.5', reasoning: 'high', role: 'high' }),
  Object.freeze({ label: 'codex-mini', model: 'gpt-5.4-mini', reasoning: 'medium', role: 'mini' }),
  Object.freeze({ label: 'codex-spark', model: 'gpt-5.3-codex-spark', reasoning: 'medium', role: 'spark' }),
])

export function modelName(spec: ModelSpec | string): string {
  const model = typeof spec === 'string' ? spec : spec.model
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model spec must contain a non-empty model string')
  }
  return model.includes('/') ? model : `${model}/${typeof spec === 'string' ? 'default' : spec.reasoning || 'default'}`
}

export function baseModel(model: string): string {
  return String(model).split('/')[0] ?? ''
}

export function reasoningFromModel(model: string, fallback: string): string {
  return String(model).split('/')[1] || fallback
}

export function adapterForReasoning(reasoning: string): string {
  return ['low', 'medium', 'high'].includes(reasoning) ? `codex-${reasoning}` : 'codex-medium'
}

export function modelForRole(role: string, reviewModels: readonly Readonly<ModelSpec>[]): Readonly<ModelSpec> {
  return reviewModels.find((spec) => spec.role === role) || reviewModels[0] || { model: 'gpt-5.5', reasoning: 'high' }
}

export function isReasoning(value: string): value is Reasoning {
  return value === 'low' || value === 'medium' || value === 'high'
}
