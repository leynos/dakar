/** @file Price worst-case token usage against a versioned Dakar rate table. */

/** Describes one model/service-tier band's per-million-token USD rates. */
export interface PricingBand {
  inputUsdPerMTok: number
  cachedInputUsdPerMTok: number
  cacheWriteUsdPerMTok: number
  outputUsdPerMTok: number
}

/** Bundles a versioned exchange snapshot with rates keyed by model and tier. */
export interface PricingTable {
  version: string
  usdPerGbp: number // versioned exchange snapshot, not a constant
  rates: Record<string, PricingBand> // key: `${model}:${serviceTier}`
}

const TOKENS_PER_MILLION = 1_000_000

/** Looks up the pricing band for a model/service-tier pair, or throws. */
function bandFor(table: PricingTable, model: string, serviceTier: string): PricingBand {
  const key = `${model}:${serviceTier}`
  const band = table.rates[key]

  if (band === undefined) {
    throw new Error(
      `no pricing band for "${key}" in pricing table version "${table.version}"`,
    )
  }

  return band
}

/**
 * Estimates the worst-case USD cost of one call. Uncached input tokens are
 * priced at the cache-write band (the worst case per ADR 002), cached input
 * tokens at the cached band, and output tokens at the output band.
 */
export function estimateWorstCaseUsd(
  table: PricingTable,
  call: {
    model: string
    serviceTier: string
    inputTokens: number
    cachedInputTokens: number
    maxOutputTokens: number
  },
): number {
  const band = bandFor(table, call.model, call.serviceTier)

  const uncachedInputUsd = (call.inputTokens * band.cacheWriteUsdPerMTok) / TOKENS_PER_MILLION
  const cachedInputUsd = (call.cachedInputTokens * band.cachedInputUsdPerMTok) / TOKENS_PER_MILLION
  const outputUsd = (call.maxOutputTokens * band.outputUsdPerMTok) / TOKENS_PER_MILLION

  return uncachedInputUsd + cachedInputUsd + outputUsd
}

/** Seeds the verified 2026-08-13 rates and exchange snapshot for Dakar's models. */
export const DEFAULT_PRICING_TABLE: PricingTable = {
  // Rates re-verified against the OpenAI pricing page on 2026-08-13: Luna
  // Flex fell to a fifth of the 2026-07-18 rates and Terra Flex by a fifth.
  version: '2026-08-13',
  // Deliberately conservative (haircut) GBP->USD conversion snapshot, chosen
  // below the prevailing spot rate so GBP budgets under-admit rather than
  // over-admit. Versioned data, revised with the rest of this table.
  usdPerGbp: 1.27,
  rates: {
    'gpt-5.6-luna:flex': {
      inputUsdPerMTok: 0.1,
      cachedInputUsdPerMTok: 0.01,
      cacheWriteUsdPerMTok: 0.125,
      outputUsdPerMTok: 0.6,
    },
    'gpt-5.6-terra:flex': {
      inputUsdPerMTok: 1.0,
      cachedInputUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
      outputUsdPerMTok: 6.0,
    },
    'gpt-5.6-luna:standard': {
      inputUsdPerMTok: 0.2,
      cachedInputUsdPerMTok: 0.02,
      cacheWriteUsdPerMTok: 0.25,
      outputUsdPerMTok: 1.2,
    },
    'gpt-5.6-terra:standard': {
      inputUsdPerMTok: 2.0,
      cachedInputUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2.5,
      outputUsdPerMTok: 12.0,
    },
  },
}
