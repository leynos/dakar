/** @file Unit-test the worst-case pricing estimator from TypeScript source. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PRICING_TABLE, estimateWorstCaseUsd } from '../src/workflows/dakar-review/pricing.ts'

test('Luna Flex worked example prices uncached input at the cache-write band', () => {
  const usd = estimateWorstCaseUsd(DEFAULT_PRICING_TABLE, {
    model: 'gpt-5.6-luna',
    serviceTier: 'flex',
    inputTokens: 12_000,
    cachedInputTokens: 0,
    maxOutputTokens: 750,
  })

  assert.equal(usd, 0.00195)
})

test('Terra Flex worked example prices uncached input at the cache-write band', () => {
  const usd = estimateWorstCaseUsd(DEFAULT_PRICING_TABLE, {
    model: 'gpt-5.6-terra',
    serviceTier: 'flex',
    inputTokens: 48_000,
    cachedInputTokens: 0,
    maxOutputTokens: 2_500,
  })

  assert.equal(usd, 0.075)
})

test('cached input tokens are priced at the cached band, not the cache-write band', () => {
  // Luna Flex band: input 0.10, cached 0.01, cache-write 0.125, output 0.60 (USD per MTok).
  // 10,000 uncached (cache-write) + 2,000 cached + 500 output.
  const expected =
    (10_000 * 0.125) / 1_000_000 +
    (2_000 * 0.01) / 1_000_000 +
    (500 * 0.6) / 1_000_000

  const usd = estimateWorstCaseUsd(DEFAULT_PRICING_TABLE, {
    model: 'gpt-5.6-luna',
    serviceTier: 'flex',
    inputTokens: 10_000,
    cachedInputTokens: 2_000,
    maxOutputTokens: 500,
  })

  assert.equal(usd, expected)
})

test('an unknown model/service-tier key throws a clear, structured error', () => {
  assert.throws(
    () =>
      estimateWorstCaseUsd(DEFAULT_PRICING_TABLE, {
        model: 'gpt-5.6-luna',
        serviceTier: 'nonexistent',
        inputTokens: 100,
        cachedInputTokens: 0,
        maxOutputTokens: 100,
      }),
    /gpt-5\.6-luna:nonexistent/u,
  )
})

test('the default pricing table carries the verified 2026-08-13 rates', () => {
  assert.equal(DEFAULT_PRICING_TABLE.version, '2026-08-13')
  assert.equal(DEFAULT_PRICING_TABLE.usdPerGbp, 1.27)
  assert.deepEqual(DEFAULT_PRICING_TABLE.rates['gpt-5.6-luna:flex'], {
    inputUsdPerMTok: 0.1,
    cachedInputUsdPerMTok: 0.01,
    cacheWriteUsdPerMTok: 0.125,
    outputUsdPerMTok: 0.6,
  })
  assert.deepEqual(DEFAULT_PRICING_TABLE.rates['gpt-5.6-terra:flex'], {
    inputUsdPerMTok: 1.0,
    cachedInputUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 1.25,
    outputUsdPerMTok: 6.0,
  })
  assert.deepEqual(DEFAULT_PRICING_TABLE.rates['gpt-5.6-luna:standard'], {
    inputUsdPerMTok: 0.2,
    cachedInputUsdPerMTok: 0.02,
    cacheWriteUsdPerMTok: 0.25,
    outputUsdPerMTok: 1.2,
  })
  assert.deepEqual(DEFAULT_PRICING_TABLE.rates['gpt-5.6-terra:standard'], {
    inputUsdPerMTok: 2.0,
    cachedInputUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
    outputUsdPerMTok: 12.0,
  })
})
