# Implementation status

This document separates source code that exists from planned capabilities that have not yet been implemented.

## Implemented in source (initial foundation)
- NestJS/TypeScript backend bootstrap, environment validation, API version prefix, Helmet headers, request correlation IDs, and throttling.
- PostgreSQL/Prisma schema and a version-controlled initial SQL migration.
- Liveness and readiness endpoints.
- Account registration/login, bcrypt password hashing, opaque hashed refresh tokens, refresh rotation, revocation, and session-bound access-token validation.
- Organizations, memberships, workspaces, projects, and applications with membership-based access checks.
- Persistent project conversations and user messages, separated from application lifecycle.
- Text source file storage with immutable revision history, restore, optimistic concurrency, safe path validation, and high-confidence secret scanning.
- Application checkpoints that snapshot app metadata and source revision references, then restore atomically while preserving history and soft-deleting post-checkpoint files.
- Asynchronous AI source generation with structured-output validation, provider routing, non-executing TypeScript/JavaScript/JSON syntax checks, one metered repair attempt, atomic multi-file writes, conflict detection, secret/path checks, and honest NOT_RUN build-verification status.
- Work graph and node/dependency persistence, cycle validation, ready-node analysis, and recoverable AI planning leases.
- Provider-neutral adapters for OpenAI, Anthropic, Google AI, and Mistral; configurable routing/fallback; provider response normalization; and raw token/call usage metering.
- Internal durable job queue with atomic PostgreSQL claiming, worker leases, heartbeats, retry handling, cooperative cancellation, completion/failure recording, and authenticated job-status/cancel routes.
- Background worker loop with a concrete asynchronous work-graph planning handler and graceful shutdown cancellation.
- Raw resource usage event ledger; commercial prices and credit values are intentionally absent.
- Unit tests for health behavior, environment validation, path safety, secret scanning, AI routing, and plan parsing.
- Application verification subsystem: real non-executing static analysis (TypeScript parser diagnostics + JSON validation), real secret scanning over all live application files, and a structural package.json dependency audit. Each run persists a VerificationRun row with honest status (PASSED / FAILED / SKIPPED), severity counts, capped findings, and evidence (engine version, analyzed file counts, unsupported files). Zero analyzable files is recorded as SKIPPED, never a fabricated PASS. Verification is exposed via authenticated project-role endpoints (POST run, GET list, GET inspect) and via a SECURITY_SCAN job handler on the durable queue; BUILD and TEST kinds exist in the enum but deliberately cannot be requested because no real build/test execution exists yet.
- Reference ingestion (text references): ReferenceDocument storage (SPEC/TRANSCRIPT/NOTES/OTHER kinds) with strict input validation (title 200 chars, content 50,000 chars, named refusals), AI-backed structured requirement extraction (1-30 requirements with MUST/SHOULD/COULD priorities, up to 20 open questions) via the provider router, strict extraction parsing with named refusals, honest EXTRACTION_FAILED status with recorded errors, authenticated CRUD + extract endpoints, and a RESEARCH job handler. Image, Figma, video, and URL references are deliberately refused by name because no binary ingestion infrastructure exists yet.
- GitHub Actions workflow for schema validation, type-checking, unit tests, and backend build. This is source-code CI only; it does not deploy.
- Functional product-flow test suite (src/functional/product-flows.spec.ts): 19 end-to-end flows that boot the real NestJS app against the real CI PostgreSQL database and exercise the actual product path over HTTP - register, login, refresh rotation with replay rejection, /me, auto-created organization and workspace, project creation, application creation, conversations with messages, source-file writes with optimistic-concurrency conflicts, secret-in-file refusal, verification runs (PASSED with evidence, FAILED dependency audit, SKIPPED for empty apps), verification history, reference creation with IMAGE/secret refusals, honest EXTRACTION_FAILED extraction, tenant isolation between users, and logout revocation. The suite skips cleanly when no database or JWT secret is configured. This suite caught and led to the fix of a real boot bug: JwtModule was module-scoped, so any feature module using JwtAuthGuard (Generation, Applications, and others) failed dependency resolution when the full AppModule was actually instantiated; JwtModule is now registered globally.

## Not implemented yet
- Frontend.
- Concrete handlers for full work-graph execution, source modification, builds, tests, security scans, deployment, and other job types beyond initial source generation and work-graph planning.
- Full code-generation execution and safe sandbox runtime.
- Real build and test execution against generated applications (static security scanning exists; executed builds/tests do not).
- Sandboxed application runtime and isolated execution interface.
- File/object storage adapter for binary assets and large repositories.
- Reference ingestion for binary and external sources: screenshots, Figma files, video, websites, and repository imports (text reference documents are supported).
- Authentication email verification, password reset, MFA, social login, OAuth/SSO, invitations, and ownership transfer.
- Custom API Studio, API licensing/subscriptions, GENESIS API public product endpoints, and API consumer dashboards.
- Data Product Studio and commercial data access controls.
- Managed Operations remediation and deployment automation.
- Hosting providers, deployment adapters, custom domains, customer-cloud authorization, and infrastructure forecasting.
- Marketplace, agency white-label, partnership settlement, and wallet.
- Final credit values, prices, formulas, and commercial quotas.

## Verification state
All claims below are backed by GitHub Actions CI runs on this repository (quality workflow: Prisma generate/validate/migrate + schema-drift diff, strict type-check, Jest unit + functional tests, production build), executed and verified green by the CI executor itself. As of commit e447f5bd the full pipeline passes, including the 19 functional product flows against a real PostgreSQL service.
