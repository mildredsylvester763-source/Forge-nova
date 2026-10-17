# GENESIS implementation roadmap

This roadmap describes intended work, not completed functionality. Frontend development is explicitly out of scope until the backend foundation and core APIs are established.

## Delivery rules

- Work in additive, reviewable batches; inspect existing code before changing it.
- Keep the primary branch as the canonical source unless a deliberate branch strategy is introduced.
- Do not configure or deploy to Vercel; do not connect to or modify Supabase.
- Do not commit secrets, real credentials, customer data, or provider keys.
- A feature is complete only when implementation, authorization, persistence, and relevant automated tests exist.
- Never claim a test or build passed unless it was actually executed and observed.
- Preserve prior working functionality; avoid broad rewrites when a targeted change is safer.
- Prefer working, observable implementations over mock implementations presented as production-ready.
- Add providers behind interfaces; only integrate providers when credentials and authorization are available.
- Defer commercial prices, credit value, conversion formulas, and final quota amounts until the economic engines have been modeled and calibrated.

## Sequence

1. Repository and engineering foundation: NestJS, TypeScript, configuration validation, PostgreSQL, Prisma, health endpoints, testing conventions.
2. Identity and access: authentication, sessions, organizations, workspaces, memberships, authorization policies, audit trail.
3. Persistent project system: projects, applications, conversations, messages, files, assets, checkpoints, version history.
4. Requirements and work orchestration: intent-to-requirement graph, dependency graph, work graph, idempotent jobs, checkpoints, cancellation, retries, fault attribution.
5. AI provider layer: model registry, provider adapters, routing policy, context handling, structured outputs, safety checks, usage instrumentation.
6. Code workspace services: source manifests, file operations, diffs, checkpoint/restore, framework detection, dependency inspection.
7. Build and verification: isolated execution interface, builds, tests, regression analysis, security scans, verification evidence.
8. Reference-driven engineering: image/document/repository ingestion, visual and behavioral reconstruction, requirements extraction, fidelity checks.
9. Integration platform: provider registry, user-authorized OAuth/API credentials, custom API connector, secret storage, connector testing and revocation.
10. Deployment and hosting abstraction: environment management, deployment adapters, resource forecast, runtime telemetry, rollback and export.
11. GENESIS API: API identity, key lifecycle, entitlements, API work units, asynchronous jobs, webhooks, quotas, usage ledger and shared-user fairness.
12. Custom API business platform: API Studio, schema registry, API consumer administration, internal/private/public access, licenses, subscriptions, versioning, testing and analytics.
13. Data products: rights/provenance registry, catalog, data APIs, access grants, licensing, aggregation, privacy assessment, revocation and auditing.
14. Managed Operations: autonomy levels, monitoring, diagnosis, approvals, remediation plans, isolated patching, testing, deployment and rollback.
15. Economic engine: resource meters, estimates, reservations, actual-use reconciliation, ledger, credits, allowances, infrastructure cost, anomaly controls and calibration.
16. Marketplace, agency and white-label workspaces, templates, extensions, partnership agreements, settlement, wallets and cost recovery.
17. Scale and resilience: queues, concurrency limits, tenant isolation, caching, observability, backups, disaster recovery, load testing and operational runbooks.

The order can be adjusted when dependencies or measured engineering constraints justify it. The scope must not be silently discarded.
