# GENESIS master product specification

Status: locked product direction; implementation is incremental. This document is a product contract and roadmap, not a claim that all listed systems are already implemented.

## 1. Product definition

GENESIS is an AI-native software creation and application operations platform. It should turn plain-language requirements and user-provided references into real, maintainable software; preserve each application's state over time; and support verification, deployment, integrations, and authorized ongoing operations. It is not merely an AI chatbot, landing-page generator, code editor, or wrapper around one model provider.

Target outputs include websites, web applications, backend services, APIs, mobile applications, desktop applications, and full-stack systems. Generated software must use real source code and explicit architecture. Completion claims must be grounded in execution and verification evidence.

## 2. Baseline 130-feature inventory

The original 130-feature inventory remains part of the product scope:
- Application generation (1–20): natural-language app generation; full-stack generation; multi-platform output; React/Vue/Svelte/native output; schema, endpoint, authentication, RBAC, payment, file storage, real-time, notification, email/SMS and AI integration generation; SEO, performance, responsive design, dark mode, accessibility and localization.
- Conversational editing (21–40): project chat; visual preview; iterative/component/layout/style/feature/logic/database/API/integration editing; scenario testing; undo/history; branches/variants; A/B variants; merge/conflict handling; preference and style memory.
- Design systems (41–60): design library; theme and brand application; component/icon/animation/template libraries; industry templates; custom templates; tokens and breakpoints; CSS; Figma and image-to-code; brand kits; font/color systems; accessibility checking; export.
- Backend/data (61–80): visual schema tooling; CRUD/custom APIs; migrations; fixtures; relations; storage/CDN; jobs/queues; webhooks/events; realtime; GraphQL; API docs/testing; rate limits; caching; database/query optimization and monitoring; backups/recovery; multiple database adapters; serverless functions.
- Identity/security (81–100): email/phone/social/magic-link auth; MFA; roles and permissions; sessions; OAuth/SSO; API keys; security and dependency scans; abuse/DDoS protection; CORS; environment variables/secrets; audit; privacy compliance support; encryption; PII protection; security headers; certificate management; penetration-test recommendations.
- Deployment/operations (101–115): deploy; custom domains; TLS; CDN; scaling; dev/staging/prod; rollback; preview deployments; performance/uptime/error/log monitoring; analytics; custom dashboards; cost monitoring/optimization.
- Collaboration (116–125): collaborative editing; teams; team roles; comments/annotations; reviews/approvals; branches/merges; shared components/templates; activity feeds and notifications.
- AI features (126–130): search/recommendations; chatbot generation; content generation; image-generation integration; analytics/insights.

## 3. Persistent project lifecycle

A project is persistent and separate from its conversation. Its conceptual structure includes Application, Source, Database, Integrations, Environments, Versions, Deployments, Assets, Configuration, Work Graph, and GENESIS Chat. Deleting or archiving a chat must not implicitly delete the application. The platform must support checkpoints, diffs, rollback, and continuation of work after deployment.

## 4. Reference-driven software engineering

Users can provide screenshots, multiple images, design files, Figma material, reference websites, video, documents, spreadsheets, existing repositories, source code, or combinations. GENESIS must infer requirements and behavior, not only reproduce pixels.

Required workflow: ingest references; analyze visual hierarchy and assets; reconstruct interaction behavior; extract requirements; infer architecture and dependencies; produce a change plan; implement source code; compare visual output; run functional, regression, and security verification; refine discrepancies. Reference engines include Reference-to-Requirements, Visual Reconstruction, Interaction Reconstruction, Reference-to-Architecture, Reference-to-Source, Visual Difference, Behavioral Verification, Reference Fidelity Tracking, Multi-Reference Reconciliation, and Reference Conflict Detection. References do not grant permission to copy proprietary source, protected assets, or trademarks unlawfully.

## 5. AI and execution architecture

Build an adapter-based model-provider layer with policy-driven routing, structured output validation, context management, tool permissions, observability, and replaceable providers. The platform should transform intent into a requirements graph, feature graph, architecture graph, dependency graph, and executable work graph. Long-running work must use durable jobs, checkpoints, bounded retries, cancellation, idempotency, resource limits, and evidence-backed completion.

## 6. Integration and connector system

GENESIS does not automatically have access to users' external accounts. Each user or organization must authorize the relevant account and permissions. Built-in connectors can cover commonly requested providers; a Custom API Connector must allow users to supply API documentation/specifications, authentication requirements, schemas, and allowed operations. Store secrets encrypted through an appropriate key-management design; never hardcode credentials into generated source or logs. Support credential rotation and revocation. Do not attempt to implement every provider on day one.

## 7. Hosting, deployment and portability

Support three architectural modes:
- GENESIS Hosting: GENESIS operates the chosen hosting resources under explicit plan and usage rules.
- Customer Cloud: customers authorize their own cloud account and are billed by that provider.
- Hybrid: responsibilities and costs are split by service.

Forecast requirements before deployment and observe actual use afterward. Warn when expected scale or architecture creates substantial operational risk. Export must cover source, assets, schema/migrations, API definitions, deployment configuration, documentation, and environment-variable templates without exporting secret values. Do not promise unlimited free hosting or standalone APK self-updating without a distribution/update mechanism.

## 8. Managed Operations

Managed Operations is a separately authorized operational service, not merely passive monitoring. Autonomy levels: Level 0 Monitor Only; Level 1 Recommend; Level 2 Auto-Fix Safe Issues; Level 3 Managed Operations; Level 4 Autonomous Operations. Customers assign policies and application scopes. Sensitive changes such as destructive database operations, payment behavior, permissions, and material business logic may require approval.

Operations lifecycle: detect, diagnose, reproduce, propose a change, patch an isolated copy, test, security scan, deploy under policy, verify, monitor, and rollback when needed. Every action must be auditable. An account may assign different operation packages or levels to different subsets of its applications; each package has its own operational capacity. Exhaustion behavior and commercial values are deferred.

## 9. GENESIS API versus custom APIs

These are distinct products:
- GENESIS API: external software calls GENESIS capabilities without requiring users to open the GENESIS interface.
- Custom API Studio: an owner creates and operates APIs that expose authorized capabilities or data from their own application/service.

GENESIS API needs scoped credentials, plan entitlements, API work accounting, async job IDs, polling/webhooks/streaming where supported, metering, fair-use limits, and a usage ledger. HTTP request count must not be treated as equivalent to work consumed. Capability tiers may be combined only through a deterministic entitlement-union policy. API subscription, infrastructure, hosting, external-provider fees, and Managed Operations are separate concepts.

Custom API Studio must provide endpoint/schema design, field/resource/action permissions, authentication, private/internal/public modes, versioning, docs, testing, consumers, analytics, security, licensing and subscriptions. Owners may use their own APIs internally in other authorized applications without purchasing a license from themselves; normal security, usage tracking, and infrastructure limits still apply.

## 10. Data products and lawful commercialization

GENESIS may support data access products, licensed feeds, APIs, subscriptions, aggregate analytics, insights, and data services only where the owner has the necessary legal and contractual rights. App ownership does not automatically confer rights to resell every record stored in it.

Required systems: Data Product Studio, Data Catalog, Data Rights Registry, Data Provenance Tracking, Data Licensing Engine, Data Access API, Data Subscription Management, Data Quality Validation, Anonymization/Aggregation, Privacy Risk Assessment, Access Auditing, Revocation Controls, Product Versioning, Usage Analytics, Export/Retention Controls, and Consumer Management. Personal information, confidential customer data, third-party datasets, and regulated data require appropriate legal basis, consent/contract checks where applicable, and privacy safeguards. Access rights and purpose limitation must be enforceable in code.

## 11. Custom API business platform

Required modules: Custom API Studio, API Schema Registry, API Gateway, API Identity and Authorization, API Administration Dashboard, API Consumer Registry, API Licensing Engine, API Subscription Engine, API Versioning Engine, API Documentation Engine, API Testing Engine, API Analytics Engine, and API Security Engine. Subscription is time-based access entitlement; licensing specifies permitted use. Support internal, private, public, licensed, subscription, enterprise-agreement, and marketplace access modes with explicit authorization and audit history.

## 12. Security and trust

Use defense in depth: authentication and MFA; tenant isolation; authorization on every resource access; encryption in transit and at rest; secret management; source/dependency/secret scanning; isolated code execution; tool and network permissions; build isolation; signed and authorized releases where supported; environment separation; backups; audit; abuse controls; and rollback. Never promise invulnerability. Emergency isolation should detect suspicious behavior, restrict sensitive operations, revoke compromised credentials when authorized, quarantine affected work, restore from a trusted checkpoint, patch/test, and verify recovery.

Automated patching must use isolated candidates, regression and security tests, behavior comparison, staged rollout, post-deployment verification, and rollback. Higher payment or plan level must never bypass legal or safety restrictions.

## 13. Marketplace, agency and white-label

Marketplace scope includes application and industry templates, UI/component packs, design systems, themes, backend modules, schemas, connectors, workflows, plugins, deployment configurations, and complete apps. Creators may offer free, one-time, or subscription access subject to marketplace policy and transparent commission rules.

Agency hierarchy: GENESIS account → personal workspace → agency workspace → team workspace → applications/clients → environments/deployments/operations. White-label capabilities may include branded portals, domains, logos, colors, client management and billing.

## 14. Partnership and revenue allocation

Partnership is optional, explicitly agreed, and separate from normal subscriptions, API usage, and hosting. The previously discussed 70/30 creator/GENESIS split is a default proposal for future negotiation, not a hardcoded universal rule or final commercial decision. Agreements define eligible revenue, responsibilities, cost recovery, settlement, refunds, chargebacks, tax handling, IP, exit/export, scaling limits, and effective dates.

A versioned Partner Agreement Object controls settlement. Revenue events should be allocated through a controlled settlement service rather than hardcoded into generated apps. Keep append-only or reversal-based ledgers for app revenue, partner allocation, infrastructure costs, refunds and chargebacks. Wallet balances must be ledger-derived, not mutable unexplained numbers. Exact rates, eligibility, timing and commercial terms remain deferred.

## 15. Economic and resource engine

Prices and credit values are intentionally not decided in this phase. The architecture must eventually distinguish raw provider costs, normalized resource units, application-compute work, API work, customer-facing credits, infrastructure usage, external provider invoices, and operational capacity. Work must be estimated, authorized/reserved, measured, reconciled against actual use, and auditable. Fault attribution must distinguish platform/provider/customer/infrastructure/user/security/unknown failures. Add calibration, fairness, fraud/anomaly detection, resource reservation, checkpoint/resume, cost exposure limits, and circuit breakers before setting commercial values.

Algorithm and engine names are tracked separately in docs/ENGINE-AND-ALGORITHM-REGISTER.md; names are not a claim of implementation.

## 16. Quality bar

- No fake integrations or fake success states.
- No silent removal of agreed scope.
- No secrets in source control.
- No cross-tenant data access.
- No destructive changes without explicit authorization and safeguards.
- No claims of successful builds, tests, deployments, or integrations without evidence.
- Every feature must have a clear owner module, data model, authorization boundary, error behavior, and verification strategy.
- Optimize for reliable user outcomes and maintainable generated software, not feature-count marketing.
