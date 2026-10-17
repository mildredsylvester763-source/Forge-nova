# GENESIS

GENESIS is an AI-native software creation and application operations platform. This repository contains the backend source code only; frontend work is intentionally deferred.

## Initial architecture

- TypeScript + NestJS for the modular backend.
- PostgreSQL as the primary relational database.
- Prisma for schema management and versioned migrations.
- Background execution and provider adapters introduced behind explicit interfaces.
- Security, authorization, auditability, and testability are foundational requirements.

## Development status

The repository is being built incrementally. A feature is not considered implemented merely because it appears in the roadmap. See `docs/GENESIS-MASTER-SPEC.md` for the locked product scope and `docs/IMPLEMENTATION-ROADMAP.md` for implementation sequencing.

## Local setup

1. Install Node.js 22 or newer and PostgreSQL 16 or newer.
2. Copy `.env.example` to `.env` and configure a local PostgreSQL connection.
3. Install dependencies with `npm install`.
4. Generate the Prisma client with `npm run db:generate`.
5. Apply local migrations with `npm run db:migrate:dev`.
6. Start the API with `npm run start:dev`.

No production provider, Vercel project, or Supabase project is configured by this repository.