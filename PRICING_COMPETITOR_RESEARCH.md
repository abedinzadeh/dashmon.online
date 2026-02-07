# Dashmon pricing proposal (competitor-informed)

This document summarises public competitor pricing/plan structures and proposes Dashmon tiers that are easy to understand and predictable for teams.

## Competitor snapshots (high level)

- **UptimeRobot**: lifetime free tier and paid plans focused on faster check intervals and higher monitor counts. (Pricing page)
- **StatusCake**: free tier with limited monitors; paid tiers increase monitors and reduce check interval (down to ~1 min on paid). (Pricing page)
- **Better Stack (Uptime)**: free tier with limited monitors; paid pricing is per-responder/seat for incident + uptime features. (Pricing page / Uptime page)
- **Pingdom**: pricing oriented around synthetic checks / enterprise scale and add-ons; commonly positioned as higher-cost for teams. (Pricing pages)

Sources:
- UptimeRobot pricing: https://uptimerobot.com/pricing/
- StatusCake pricing: https://www.statuscake.com/pricing/
- Better Stack pricing: https://betterstack.com/pricing/ and https://betterstack.com/uptime
- Pingdom pricing: https://www.pingdom.com/pricing/ and https://www.pingdom.com/synthetic-pricing/

## Observed market patterns

1) **Free tiers are common** for basic uptime checks (5–15 minute intervals, small monitor counts).
2) **Paid tiers differentiate** by:
   - Faster check intervals (1 min / 30 sec / 15 sec)
   - Higher monitor limits
   - Team features (roles, audit logs)
   - Alerting channels (SMS/phone/on-call) and integrations
   - Longer retention + reporting
3) **Pricing model** varies:
   - Per monitor (predictable for small setups)
   - Per seat/responder (common when bundling on-call/incident tools)
   - Usage-based (checks, pageviews, etc.)

## Proposed Dashmon tiers (simple + predictable)

> Keep tiers focused on check interval + monitor count + retention. Add “Enterprise” for custom needs.

### Free — $0
- Monitors: **25**
- Check interval: **5 minutes**
- Retention: **7 days**
- Alerts: Email + basic integrations
- Best for: small sites, proof-of-concept

### Starter — $9 / month
- Monitors: **100**
- Check interval: **1 minute**
- Retention: **30 days**
- Alerts: Email + integrations
- Best for: small teams, single environment

### Pro — $29 / month
- Monitors: **300**
- Check interval: **30 seconds**
- Retention: **180 days**
- Alerts: Email + integrations + maintenance windows
- Best for: growing teams / multi-site ops

### Business — $79 / month
- Monitors: **1,000**
- Check interval: **15 seconds**
- Retention: **365 days**
- Team: roles, audit log (roadmap), priority support
- Best for: larger operations and critical services

### Enterprise — Custom
- Monitors: custom
- Check interval: custom (including multi-region / dedicated workers)
- SSO/SAML, SLA options, dedicated support
- Best for: regulated orgs / very large estates

## Rationale

- The **Free** tier matches what users expect in the market (basic uptime, slower intervals).
- The **Starter/Pro** tiers are price points that are easy to buy without procurement friction and map directly to better monitoring frequency.
- The **Business** tier offers the “serious” interval (15 seconds) and longer retention, aligned to higher operational value.
- Enterprise remains flexible for custom contracts, onboarding and compliance.

## Notes / next steps

- Decide currency (USD vs AUD) and whether billing is monthly/annual with discount.
- Decide whether monitors include only HTTP checks or also other check types.
- Consider add-ons later (SMS bundles, extra retention, extra team seats) without complicating the base tiers.
