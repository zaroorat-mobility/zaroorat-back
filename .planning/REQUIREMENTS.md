# Requirements: Production Readiness Remediation

## Active Milestone Requirements

### Phase 0: Baseline & Audit Verification

- [x] Complete READ-ONLY production-readiness audit across 49 architectural domains
- [x] Verify evidence for AUDIT-001 through AUDIT-006 with exact code tracing & math

### Phase 1: FCM Push Implementation (P0 Blocker)

- [ ] Implement `FcmPushProvider` adhering to `PushProvider` interface using `firebase-admin` SDK
- [ ] Configure Android & iOS APNs payload options in FCM v1 HTTP API
- [ ] Implement automatic device token unregistration on `messaging/registration-token-not-registered`

### Phase 2: Production Infrastructure Readiness

- [ ] Airtel DLT + SMS Production Verification (Principal Entity registration, sender/header, approved SMS templates, template IDs, template variables/placeholders, OTP/service/transactional classification, production API credentials & endpoint, delivery status/callbacks, failure handling, retry behavior, rate limits, non-sensitive logging, staging verification, readiness evidence)
- [ ] Verify automated RDS / Cloud SQL continuous WAL archiving & 35-day PITR retention schedule
- [ ] Verify Prometheus `/metrics` scraping and Pino structured log aggregation

### Phase 3: Outbox Worker Deployment Topology Decision

- [ ] Implement `ENABLE_OUTBOX_RELAY` environment toggle to isolate OutboxRelay execution to worker processes

### Phase 4: Middleware Cleanup (AUDIT-003)

- [ ] Remove or re-export canonical decorators from `src/middleware/auth.ts`, `role.ts`, and `idempotency.ts`

### Phase 5: Full Production E2E Testing

- [ ] Build end-to-end integration test suite for ride request -> dispatch -> accept -> start -> complete -> fare collection
- [ ] Build webhook reconciliation & signature verification test suite for Razorpay & Stripe

### Phase 6: Load & Concurrency Stress Testing

- [ ] Benchmark 1,000 active concurrent drivers emitting GPS updates every 3 seconds to Socket.IO
- [ ] Validate H3 spatial query latency (< 20ms) and PostgreSQL IOPS under load

### Phase 7: Security & Deployment Certification

- [ ] Run automated vulnerability audit (`npm audit` / `security.yml`)
- [ ] Verify non-root `node` container execution in Dockerfile

### Phase 8: Staging Certification

- [ ] Deploy container to staging cluster and validate Razorpay sandbox, Airtel SMS, and FCM push notifications

### Phase 9: Production Release

- [ ] Execute `npx prisma migrate deploy` and cut over live API and worker cluster

### Post-Launch Deferred

- [ ] AUDIT-006 location persistence optimization (Redis stream buffering when active rides exceed 2,000+)
