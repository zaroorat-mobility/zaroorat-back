# Release Checklist

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [Deployment](./DEPLOYMENT.md), [Monitoring](./MONITORING.md)

Run this for every production release. Copy it into the release ticket/PR and check items off.

---

## Pre-release
- [ ] All PRs merged to `main`; CI green (lint, type-check, unit, integration, build).
- [ ] Version bumped/tagged (`vMAJOR.MINOR.PATCH`); changelog updated.
- [ ] **Migrations reviewed** and backward-compatible (expand→migrate→contract). No breaking change to the running version during rolling deploy. ([Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md))
- [ ] Migrations tested on staging against prod-like data; lock/backfill impact understood.
- [ ] New env vars added to `env.schema.ts` **and** the secret store **and** `.env.example`. ([Environment](../02_ENGINEERING/ENVIRONMENT_GUIDE.md))
- [ ] Feature flags for new P1/P2 features default to a safe state.
- [ ] Docs updated in the same PRs (API schemas/Swagger, architecture, ADRs).
- [ ] Rollback plan confirmed (previous image tag; migration down-path if any).
- [ ] Both images build: API (`Dockerfile`) and worker (`Dockerfile.worker`).

## Deploy
- [ ] Announce the release window in the ops channel.
- [ ] Run `prisma migrate deploy` (gated step) — verify success.
- [ ] Rolling deploy; `/ready` gates each instance.
- [ ] Workers redeployed and consuming (queue depth draining, not growing).

## Post-deploy verification
- [ ] Health/readiness green across instances.
- [ ] **Smoke-test the core loop:** OTP login → estimate → request → accept → complete → pay.
- [ ] Realtime working (location + trip state push).
- [ ] Dashboards at baseline: error rate, p95 latency, match rate, payment success. ([Monitoring](./MONITORING.md))
- [ ] Queues healthy; **payments dead-letter not growing**.
- [ ] No spike in error logs; spot-check a `requestId` end-to-end.

## Rollback triggers (abort/undo if…)
- [ ] Core-loop smoke test fails.
- [ ] Error rate or latency breaches budget and won't recover.
- [ ] Payments failing or dead-letter climbing.
- [ ] A migration caused unexpected locks/errors.
→ Roll back to the previous tag ([Deployment §7](./DEPLOYMENT.md)); if severe, open an [incident](./INCIDENT_RESPONSE.md).

## After a clean release
- [ ] Close the release ticket with the version and a one-line summary.
- [ ] Watch dashboards through the next peak.
- [ ] Note anything rough for the next release's process.
