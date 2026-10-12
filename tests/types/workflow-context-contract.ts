/**
 * Compile-only checks for workflow reasoning, routing, and context contracts.
 *
 * @module
 */

import type { WorkflowConfig } from '../../src/workflows/dakar-review/config.ts'
import { lunaFlexLaneRole } from '../../src/workflows/dakar-review/model-routing.ts'
import { taskPrompt } from '../../src/workflows/dakar-review/prompts.ts'
import { buildFlexFinderPlan } from '../../src/workflows/dakar-review/task-graph.ts'
import type { FlexFinderConfig } from '../../src/workflows/dakar-review/task-graph.ts'
import type { PreparedReview, PromptContext, ReviewTask, WorkflowArgs } from '../../src/workflows/dakar-review/types.ts'

type ResolvedReasoning = WorkflowConfig['lunaReasoning']
const lowReasoning: ResolvedReasoning = 'low'
const mediumReasoning: ResolvedReasoning = 'medium'
const highReasoning: ResolvedReasoning = 'high'
// @ts-expect-error unsupported resolved reasoning must remain unrepresentable
const invalidReasoning: ResolvedReasoning = 'urgent'

const workflowArgs: WorkflowArgs = {
  lunaReasoning: lowReasoning,
  contextGuidance: 'Optional host-translated context capabilities.',
}
const defaultWorkflowArgs: WorkflowArgs = {}
const optionalPromptGuidance: Parameters<typeof taskPrompt>[3] = workflowArgs.contextGuidance
// @ts-expect-error GitHub identity remains at the CLI adapter boundary
const githubIdentityArgs: WorkflowArgs = { repoSlug: 'owner/repository' }

const finderConfig: FlexFinderConfig = {
  maxLunaFlexCalls: 4,
  maxTasks: 8,
  transactionMaxFiles: 5,
  lunaRole: lunaFlexLaneRole(mediumReasoning),
  maxFindings: 20,
}
// @ts-expect-error only registered Luna Flex lanes may reach the finder planner
const invalidLunaRole: FlexFinderConfig['lunaRole'] = 'luna-ultra'

const prepared: PreparedReview = { reviewBase: 'base', headCommit: 'head', changedFiles: ['src/example.ts'] }
for (const lunaRole of ['luna', 'luna-medium', 'luna-low'] satisfies FlexFinderConfig['lunaRole'][]) {
  buildFlexFinderPlan(prepared, { ...finderConfig, lunaRole })
}

const task: ReviewTask = {
  adapter: 'pi-luna-flex-high',
  assignedModel: 'gpt-5.6-luna/high',
  files: ['src/example.ts'],
  kind: 'source',
  maxFindings: 3,
  model: 'gpt-5.6-luna',
  role: 'luna',
  taskId: 'luna-flex-1',
  verificationPolicy: 'verify-all',
}
const promptContext: PromptContext = {
  agentInstructions: null,
  policy: { version: 1, pathInstructions: [], customChecks: [], ignoredKeys: [] },
  policyPath: '',
  repoRoot: '/repo',
}
taskPrompt(task, prepared, promptContext, workflowArgs.contextGuidance)

void [highReasoning, invalidReasoning, defaultWorkflowArgs, optionalPromptGuidance, githubIdentityArgs, invalidLunaRole]
