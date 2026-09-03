/**
 * Route Dakar incremental review work through ODW agents.
 *
 * The workflow fans scoped review packs out to the pi Flex Luna finder lane,
 * audits candidates through the pi Flex Terra lane, and renders the accepted
 * review deterministically. The installable CLI prepares the unreviewed range
 * and records completed heads in Dakar's XDG state history.
 *
 * @module
 */

/** ODW workflow descriptor: identity, guidance, and declared phase order. */
export const meta = {
  /** Stable workflow identifier surfaced to the ODW runtime. */
  name: 'dakar-review',
  /** One-line summary of what the workflow does. */
  description:
    'Review only previously unreviewed commits using review-policy YAML guidance, pi Flex Luna finder packs, a pi Flex Terra audit, deterministic rendering, and XDG review history.',
  /** Guidance on the situations in which this workflow should be selected. */
  whenToUse:
    'Use on a git branch when a CodeRabbit-compatible YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  /** Ordered dashboard phases the run advances through. */
  phases: [
    {
      /** Human-readable phase title shown in the dashboard. */
      title: 'Plan',
    },
    {
      /** Human-readable phase title shown in the dashboard. */
      title: 'Review',
    },
    {
      /** Human-readable phase title shown in the dashboard. */
      title: 'Audit',
    },
  ],
}
