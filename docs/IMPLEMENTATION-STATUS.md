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
- GitHub Actions workflow for schema validation, type-checking, unit tests, and backend build. This is source-code CI only; it does not deploy.

## Not implemented yet
- Frontend.
- Concrete handlers for full work-graph execution, source modification, builds, tests, security scans, deployment, and other job types beyond initial source generation and work-graph planning.
- Full code-generation execution and safe sandbox runtime.
- Actual build/test/security-scan execution against generated applications.
- File/object storage adapter for binary assets and large repositories.
- Reference ingestion for screenshots, Figma files, video, documents, websites, and repositories.
- Authentication email verification, password reset, MFA, social login, OAuth/SSO, invitations, and ownership transfer.
- Custom API Studio, API licensing/subscriptions, GENESIS API public product endpoints, and API consumer dashboards.
- Data Product Studio and commercial data access controls.
- Managed Operations remediation and deployment automation.
- Hosting providers, deployment adapters, custom domains, customer-cloud authorization, and infrastructure forecasting.
- Marketplace, agency white-label, partnership settlement, and wallet.
- Final credit values, prices, formulas, and commercial quotas.

## Verification state
The repository contains automated tests and a GitHub Actions workflow, but this coding environment could not clone the repository or install dependencies because external network resolution was unavailable. Therefore no local build/test pass is claimed here. The next connected CI run must verify Prisma schema validity, TypeScript compilation, unit tests, and build output before production use.
