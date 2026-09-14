# Project: backend_zaroorat

## Description

Backend API microservice / monolith for Zaroorat platform providing ride hailing, driver management, real-time tracking, payments, dynamic pricing, and administrative management.

## Active Milestone: Production Readiness Remediation

### Milestone Objectives

- Build production Firebase Cloud Messaging (FCM v1) push provider (`PushProvider` interface) for iOS & Android background notifications.
- Verify production infrastructure readiness (Msg91 DLT template IDs, AWS RDS / GCP Cloud SQL 35-day PITR automated backup retention, Pino/Prometheus metrics).
- Implement `ENABLE_OUTBOX_RELAY` topology toggle to isolate OutboxRelay execution to dedicated worker processes (`node dist/worker.js`).
- Resolve middleware technical debt (AUDIT-003).
- Execute full production E2E testing pipeline, load/concurrency stress testing (1,000 active drivers), and security certification.
- Achieve Staging Certification and execute zero-downtime Production Release cutover.

## Verified Baseline Audit Status

- **P0 Blocker**: AUDIT-002 (Missing FCM push provider).
- **False Positives**: AUDIT-001 (JWT secret fallback strictly blocked by Zod startup schema), AUDIT-005 (Mock payment gateway strictly blocked in prod/staging).
- **P1 Technical Debt**: AUDIT-003 (Unused root middleware stubs), AUDIT-004 (OutboxRelay `FOR UPDATE SKIP LOCKED` + Socket.IO Redis adapter is architecturally valid; Kafka not required).
- **Infrastructure Verification**: DB Backup/PITR, Msg91 DLT template registration, Pino/Prometheus APM metrics.
- **Deferred (Post-Launch)**: AUDIT-006 (Location persistence optimization; 10-15s sampling is sufficient for initial launch).

## Primary Contacts / Roles

- Backend Team / Lead Developers
