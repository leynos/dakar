import { adapterForReasoning, baseModel, modelForRole, modelName } from './model-routing.ts'
import type { ModelSpec, PreparedReview, ReviewTask } from './types.ts'

export interface TaskGraphConfig {
  maxFindings: number
  maxTasks: number
  reviewModels: readonly Readonly<ModelSpec>[]
}

export function classifyPath(path: string): string {
  if (/\b(test|tests|spec|__tests__)\b/u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)) return 'tests'
  if (/\.(md|mdx|rst|adoc)$/u.test(path) || path.startsWith('docs/')) return 'docs'
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/u.test(path)) return 'dependency'
  if (/\.(ya?ml|toml|json|ini|conf)$/u.test(path) || path.startsWith('.github/')) return 'config'
  if (/\.(c|cc|cpp|cs|go|java|js|jsx|mjs|py|rb|rs|ts|tsx)$/u.test(path)) return 'source'
  return 'unknown'
}

export function chunk<T>(values: T[], size: number): T[][] {
  const chunks = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

export function taskSpec(kind: string, files: string[], index: number, config: TaskGraphConfig): ReviewTask {
  const role = kind === 'source' ? 'high' : kind === 'tests' ? 'medium' : kind === 'docs' || kind === 'config' ? 'mini' : 'spark'
  const assigned = modelForRole(role, config.reviewModels)
  return {
    taskId: `${kind}-${index + 1}`, kind, files, assignedModel: modelName(assigned),
    adapter: adapterForReasoning(assigned.reasoning || 'medium'), model: baseModel(assigned.model || ''),
    modelLabel: assigned.label, role,
    maxFindings: Math.max(1, Math.min(config.maxFindings, kind === 'source' ? 6 : 3)),
    verificationPolicy: role === 'high' ? 'verify-all' : 'verify-non-low-and-sampled-low',
  }
}

export function distributeTaskSlots(groups: Array<{ kind: string; files: string[] }>, budget: number): Map<string, number> {
  const slots = new Map(groups.map((group) => [group.kind, 1]))
  let remaining = budget - groups.length
  while (remaining > 0) {
    let target: string | undefined
    let worstLoad = -1
    for (const group of groups) {
      const allocated = slots.get(group.kind) ?? 1
      if (allocated >= group.files.length) continue
      const load = group.files.length / allocated
      if (load > worstLoad) { worstLoad = load; target = group.kind }
    }
    if (target === undefined) break
    slots.set(target, (slots.get(target) ?? 1) + 1)
    remaining -= 1
  }
  return slots
}

export function buildTaskGraph(prepared: PreparedReview, config: TaskGraphConfig): ReviewTask[] {
  const groups = new Map<string, string[]>()
  for (const file of prepared.changedFiles || []) {
    const kind = classifyPath(file)
    const key = kind === 'dependency' || kind === 'unknown' ? 'source' : kind
    const files = groups.get(key) ?? []
    files.push(file)
    groups.set(key, files)
  }
  const populated = ['source', 'tests', 'config', 'docs']
    .map((kind) => ({ kind, files: groups.get(kind) || [] }))
    .filter((group) => group.files.length > 0)
  const budget = Math.max(1, config.maxTasks) - 1
  if (populated.length > budget) {
    throw new Error(`maxTasks=${config.maxTasks} is too small: ${populated.length} changed-file groups plus a review summary cannot fit; raise maxTasks or narrow the review range`)
  }
  const slots = distributeTaskSlots(populated, budget)
  const tasks: ReviewTask[] = []
  for (const group of populated) {
    const size = Math.max(1, Math.ceil(group.files.length / (slots.get(group.kind) ?? 1)))
    for (const [index, part] of chunk(group.files, size).entries()) tasks.push(taskSpec(group.kind, part, index, config))
  }
  tasks.push(taskSpec('review-summary', prepared.changedFiles || [], 0, config))
  return tasks
}

export function defaultTaskGraph(config: TaskGraphConfig): ReviewTask[] {
  const tasks = [
    taskSpec('source', ['src/example.js'], 0, config), taskSpec('tests', ['tests/example.test.js'], 0, config),
    taskSpec('config', ['examples/df12-code-review.yaml'], 0, config), taskSpec('docs', ['docs/users-guide.md'], 0, config),
  ]
  const summary = taskSpec('review-summary', ['src/example.js', 'tests/example.test.js'], 0, config)
  return [...tasks.slice(0, Math.max(0, config.maxTasks - 1)), summary]
}
