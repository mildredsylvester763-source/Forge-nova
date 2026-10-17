# Backend API surface

All routes are under /api/v1. Routes marked authenticated require a bearer access token. This list documents current code paths; it does not imply the broader product roadmap is complete.

## Health
- GET /api/v1/health/live — process liveness.
- GET /api/v1/health/ready — readiness including a PostgreSQL query.

## Identity
- POST /api/v1/auth/register — creates an account, owner organization, personal workspace, and session.
- POST /api/v1/auth/login — authenticates an account and issues access/refresh tokens.
- POST /api/v1/auth/refresh — rotates a one-time refresh token and its bound session.
- POST /api/v1/auth/logout — revokes the refresh session; protected requests tied to it are then rejected.
- GET /api/v1/auth/me — authenticated account profile.

## Organizations and workspaces
- GET /api/v1/organizations — list organizations the user belongs to.
- POST /api/v1/organizations — create an organization, owner membership, and general workspace.
- GET /api/v1/organizations/:organizationId/members — list members.
- POST /api/v1/organizations/:organizationId/members — add an existing active GENESIS account with a non-owner role.
- GET /api/v1/workspaces — list workspaces visible to the user.
- POST /api/v1/workspaces — create a workspace for an organization where the user is an owner/admin.

## Projects and applications
- GET /api/v1/workspaces/:workspaceId/projects — list projects.
- POST /api/v1/workspaces/:workspaceId/projects — create a project.
- GET /api/v1/projects/:projectId — read a project and its applications.
- PATCH /api/v1/projects/:projectId — update project name/description.
- POST /api/v1/projects/:projectId/archive — archive a project without deleting its data.
- GET /api/v1/projects/:projectId/applications — list applications.
- POST /api/v1/projects/:projectId/applications — create an application.

## Persistent conversations
- GET /api/v1/applications/:applicationId/conversations — list conversations.
- POST /api/v1/applications/:applicationId/conversations — create a conversation.
- PATCH /api/v1/conversations/:conversationId/archive — archive a conversation independently from the application.
- GET /api/v1/conversations/:conversationId/messages — read persisted messages.
- POST /api/v1/conversations/:conversationId/messages — store a user message. This endpoint persists the message; it does not yet invoke the AI execution engine.

## Source files
- GET /api/v1/applications/:applicationId/files — list file metadata.
- GET /api/v1/applications/:applicationId/files/:fileId — read source content.
- POST /api/v1/applications/:applicationId/files — create/update a file with optimistic revision control.
- GET /api/v1/applications/:applicationId/files/:fileId/revisions — list immutable revision metadata.
- POST /api/v1/applications/:applicationId/files/:fileId/restore/:revision — restore a prior revision only if expectedCurrentRevision matches.
- DELETE /api/v1/applications/:applicationId/files/:fileId/revision/:expectedRevision — soft-delete only if the expected revision matches.

File writes reject unsafe paths, cap text size, preserve revision history, and scan for likely credentials. Binary asset storage is not implemented yet.

## Application checkpoints
- POST /api/v1/applications/:applicationId/checkpoints — capture application metadata and source-file revision references.
- GET /api/v1/applications/:applicationId/checkpoints — list checkpoints without exposing the full manifest.
- POST /api/v1/applications/:applicationId/checkpoints/:checkpointId/restore — restore the checkpoint atomically by creating new file revisions; unrelated newer files are soft-deleted rather than physically removed.

The initial checkpoint implementation is limited to 500 source-file records per application and 1 MB of manifest metadata. Source revisions are retained because checkpoints depend on them.

## AI source generation
- POST /api/v1/applications/:applicationId/generate — enqueue a source-generation job. Body: prompt and idempotencyKey. The worker validates the AI's JSON output, scans generated content, and atomically applies the multi-file batch with revision checks.
- GET /api/v1/applications/:applicationId/jobs/:jobId — inspect progress and result.
- POST /api/v1/applications/:applicationId/jobs/:jobId/cancel — request cancellation.

Source generation does not claim that output builds or tests successfully. The worker parses TypeScript/JavaScript/JSON syntax without executing generated code and attempts one AI repair pass for malformed output or syntax errors. The job result explicitly reports build verification as NOT_RUN until an isolated build/test runner is implemented.

## Work graphs
- GET /api/v1/applications/:applicationId/work-graphs — list work graphs.
- POST /api/v1/applications/:applicationId/work-graphs — create a draft graph preserving the original request.
- GET /api/v1/work-graphs/:graphId — read a graph and its dependencies.
- POST /api/v1/work-graphs/:graphId/nodes — add a dependency-ordered node.
- GET /api/v1/work-graphs/:graphId/validate — validate graph cycles and inspect currently ready nodes.
- POST /api/v1/work-graphs/:graphId/plan — enqueue an idempotent background planning job and return its job ID. The worker calls a configured AI provider, validates the plan, and atomically persists nodes and dependency edges.

Planning requires a server-side AI provider key and default model. If none is configured, the route returns an explicit service-unavailable error; it does not fabricate a plan.

## Background jobs
The worker currently has a concrete handler for work-graph planning. Other job types remain unavailable until their handlers and isolated execution environments are implemented.

## Internal services not exposed as public routes yet
- AI provider registry and model router.
- Durable job queue with worker leases, heartbeat, retry, cancellation and result-size limits.
- Raw resource usage event ledger.

These are internal services until worker execution, entitlements, authorization policy, and user-facing job semantics are implemented.
