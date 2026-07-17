/**
 * Declare ODW's injected globals for compile-time checking only.
 *
 * @module
 */

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

/** Runs one injected ODW agent call and returns its decoded result. */
declare function agent<T = unknown>(prompt: string, options?: AgentOptions): Promise<T>
/** Writes an operational message through the injected ODW logger. */
declare function log(message: string): void
/** Runs injected ODW tasks concurrently while retaining failed slots as null. */
declare function parallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<Array<T | null>>
/** Marks the named workflow phase through the injected ODW runtime. */
declare function phase(name: string): void
/** Applies an injected ODW stage to each input and retains failed slots as null. */
declare function pipeline<Input, Output>(
  items: readonly Input[],
  stage: (item: Input) => Promise<Output>,
): Promise<Array<Output | null>>
/** Delays workflow execution by a non-negative number of milliseconds. */
declare function sleep(milliseconds: number): Promise<void>
/** Validates source text with the injected ODW workflow validator. */
declare function validate(source: string): ValidationResult
/** Invokes another ODW workflow by reference with optional serializable arguments. */
declare function workflow<T = unknown>(reference: string, workflowArgs?: unknown): Promise<T>
