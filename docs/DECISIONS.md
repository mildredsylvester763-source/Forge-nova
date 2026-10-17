# Architecture decision record

## Accepted direction

1. Product: GENESIS, AI-native software creation and application operations.
2. Repository: mildredsylvester763-source/Forge-nova.
3. Backend only for the initial development stage; no frontend work yet.
4. Core language/runtime: TypeScript on Node.js, with NestJS modules.
5. Primary relational database: PostgreSQL.
6. Database access and schema migrations: Prisma, with schema and migration history version-controlled.
7. Python is allowed for specialized AI/data workloads when a real technical reason supports a separate worker; it is not the default core backend language.
8. Architecture begins as a modular monolith with durable background execution and explicit provider adapters.
9. Source-code work only: do not configure or deploy to Vercel; do not connect to or modify Supabase.
10. Do not set commercial prices, credit values, conversion formulas, or final quota numbers yet.
11. No secrets or credentials in Git.
12. Do not report builds/tests as successful unless executed and observed.

## Deferred decisions

- Exact authentication provider and external OAuth integrations.
- Queue technology and production worker deployment.
- Secret manager and key-management provider.
- Hosting providers and customer-cloud connection flows.
- Payment provider, subscription pricing, and revenue-settlement implementation.
- Credit values, prices, quota quantities, and conversion equations.
- Exact production deployment topology and service decomposition.

Deferred decisions must not block implementing provider-neutral interfaces and safe foundational abstractions where appropriate.
