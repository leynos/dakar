/**
 * Enforce tested-example markers in Dakar's user-facing documents.
 *
 * @module
 */

import { loadTestedExamples } from './tested-examples.mjs'

const examples = loadTestedExamples()
process.stdout.write(`Checked ${examples.size} tested documentation examples.\n`)
