type JsonSchema = Readonly<Record<string, unknown>>

interface AgentOptions {
  readonly adapter?: string
  readonly agentType?: string
  readonly isolation?: 'worktree'
  readonly label?: string
  readonly model?: string
  readonly phase?: string
  readonly schema?: JsonSchema
}

interface WorkflowBudget {
  readonly total: number | null
  spent(): number
  remaining(): number
}

interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

declare const args: unknown
declare const budget: WorkflowBudget

declare function agent<T = unknown>(prompt: string, options?: AgentOptions): Promise<T>
declare function log(message: string): void
declare function parallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<Array<T | null>>
declare function phase(name: string): void
declare function pipeline<Input, Output>(
  items: readonly Input[],
  stage: (item: Input) => Promise<Output>,
): Promise<Array<Output | null>>
declare function validate(source: string): ValidationResult
declare function workflow<T = unknown>(reference: string, workflowArgs?: unknown): Promise<T>
