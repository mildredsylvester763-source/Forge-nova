# GENESIS

GENESIS is an AI-native software creation and application operations platform. This repository contains the backend source code only; frontend work is intentionally deferred.

## Initial architecture

- TypeScript + NestJS for the modular backend.
- PostgreSQL as the primary relational database.
- Prisma for schema management and versioned migrations.
- Background execution and provider adapters introduced behind explicit interfaces.
- Security, authorization, auditability, and testability are foundational requirements.

## Current backend foundation

The source currently includes authentication and organization/workspace/project APIs, persistent conversations, versioned source files, AI provider adapters, a raw resource-usage ledger, durable jobs, AI work-graph planning, and asynchronous source generation. The generated source batch is validated and written atomically. Build/test verification is deliberately reported as NOT_RUN until a safe isolated runtime is implemented.

The complete product contract is in `docs/GENESIS-MASTER-SPEC.md`; implementation sequencing is in `docs/IMPLEMENTATION-ROADMAP.md`; current implemented-versus-pending scope is in `docs/IMPLEMENTATION-STATUS.md`; API routes are listed in `docs/API-SURFACE.md`.

## Development status

The repository is built incrementally. A feature is not considered implemented merely because it appears in the roadmap. No frontend is being built in this phase.

## Local setup

1. Install Node.js 22 or newer and PostgreSQL 16 or newer.
2. Copy `.env.example` to `.env` and configure a local PostgreSQL connection.
3. Install dependencies with `npm install`.
4. Generate the Prisma client with `npm run db:generate`.
5. Apply local migrations with `npm run db:migrate:dev`.
6. Start the API with `npm run start:dev`.

For source generation, configure at least one server-side AI provider key and its default model in `.env`. Provider credentials must never be exposed to clients or committed to source control.

No production provider, Vercel project, or Supabase project is configured by this repository.