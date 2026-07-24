/**
 * @file Route Dakar incremental review work through ODW agents.
 *
 * The workflow fans scoped review packs out to the pi Flex Luna finder lane,
 * audits candidates through the pi Flex Terra lane, and renders the accepted
 * review deterministically. The installable CLI prepares the unreviewed range
 * and records completed heads in Dakar's XDG state history.
 */

export const meta = {
  name: 'dakar-review',
  description:
    'Review only previously unreviewed commits using review-policy YAML guidance, pi Flex Luna finder packs, a pi Flex Terra audit, deterministic rendering, and XDG review history.',
  whenToUse:
    'Use on a git branch when a CodeRabbit-compatible YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  phases: [
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Audit' },
  ],
}
