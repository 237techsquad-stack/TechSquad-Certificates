# techsquad-certificates

A minimal TanStack Start app with one route and plain CSS.

```bash
npm install
npm run dev
```

Edit `src/routes/index.tsx` to get started. Add route files under
`src/routes`; TanStack Router updates `src/routeTree.gen.ts` for you.

Build the production app with:

```bash
npm run build
```

## Production deployment on Vercel

The Vite configuration uses the official `nitro/vite` integration alongside
TanStack Start. Vercel detects TanStack Start and Nitro and applies its
framework build/runtime integration; no custom `vercel.json`, output path,
rewrite, or separate production `start` script is required for this setup.
Build locally with:

```bash
npm run build
```

Configure the following server-side variables in Vercel's project environment
settings. Set the appropriate values separately for Production and Preview;
do not put credentials in source code or client-prefixed `VITE_` variables.

- `MONGODB_URI` (required).
- `MONGODB_DATABASE_NAME` (required only if `MONGODB_URI` has no database
  path). A database must be selected explicitly; the application does not
  choose one implicitly.
- `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_SESSION_KEY`, `APP_ORIGIN`,
  `OIDC_REDIRECT_URI`, and `ADMIN_OIDC_SUBJECTS` (required for authentication).

For each environment, `APP_ORIGIN` must match that deployment's origin, and
`OIDC_REDIRECT_URI` must use that origin with the registered callback path
`/api/auth/callback`. Register the corresponding callback URL with the OIDC
provider. Preview deployments may have distinct origins; configure their
origins and callback URLs as appropriate rather than reusing production
settings blindly.

### Public verification rate limit

The public certificate-verification endpoint uses the Vercel Firewall rate
limiting SDK and fails closed with `{ "valid": false }` and HTTP 503 if it is
not running with both `VERCEL=1` and `NODE_ENV=production`, the trusted client
IP is unavailable, the Firewall rule is missing, or the rate-limit check
fails. Requests over the configured limit receive the same minimal body with
HTTP 429, before any certificate lookup. All responses remain
`Cache-Control: no-store`.

Before enabling the endpoint on Vercel, create and publish a Firewall custom
rule using the `@vercel/firewall` condition and this exact rate-limit ID:
`public-certificate-verification`. Configure its per-IP request limit and
window in the Vercel Firewall dashboard. The application uses Vercel's
documented `x-forwarded-for` client-IP header only when Vercel's documented
`VERCEL=1` system environment variable is present, and rejects missing or
malformed IP values. It also requires `NODE_ENV=production`, because the SDK
returns an un-limited result in development unless given a separate
development firewall host. Do not set `VERCEL` manually outside Vercel to
bypass the platform-boundary check.

Vercel documents that Firewall rate-limit counters are tracked per region, so
traffic using multiple regions can exceed the per-region configured limit.
This is shared across instances within a region, not a strict global
cross-region quota. Rate limiting must be configured for the relevant Vercel
deployments; the repository does not verify dashboard configuration.

Missing or invalid authentication configuration fails authentication requests
with a generic error response; configuration values and stack traces are not
sent to the client. Keep these values server-side and do not expose them
through client-prefixed environment variables.

Vercel deployment and live authentication verification are still pending.
This repository has not been deployed, and no real identity-provider or
database connection has been tested.

## MongoDB server configuration

The server-side MongoDB foundation reads `MONGODB_URI` when a server operation
requests the database. Set `MONGODB_DATABASE_NAME` only when the URI does not
include a database name. The application does not connect during startup or
page rendering.

Run the focused database configuration tests and TypeScript check with:

```bash
npm test
npm run typecheck
```

## Temporary MongoDB connectivity diagnostic

The temporary `POST /api/diagnostics/mongodb` endpoint is available only while
`NODE_ENV` is `development`. It sends a read-only MongoDB `ping` and returns
only `{ "status": "success" }` or `{ "status": "failure" }`. It is not called by
page rendering or application startup.

To invoke it locally, start the development server:

```powershell
npm run dev
```

In a second PowerShell window, explicitly send a POST request:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/diagnostics/mongodb
```

`success` means the server completed the ping. `failure` means the check was
disabled outside development or the server could not complete it; the response
does not disclose the cause. The diagnostic may emit a generic failure category
in the server console, but never the connection details or raw error.

This endpoint is temporary. After verification, remove
`src/routes/api/diagnostics/mongodb.ts`,
`src/lib/mongodb-diagnostic.server.ts`, and
`tests/mongodb-diagnostic.test.ts`, remove the diagnostic section from this
README and its test-file entry from the `test` script in `package.json`, then
run `npm run generate-routes` to remove the generated route entry.

## Authentication

The server-only `src/lib/auth.server.ts` module provides Google OpenID Connect
login, encrypted session-cookie, admin authorization, and CSRF helpers. The
login, callback, and logout routes use these helpers. Login uses the
authorization-code flow with state, nonce, and PKCE. The provider issuer is
pinned to `https://accounts.google.com`; authorization is granted only when
the verified OIDC subject is listed in the server-side
`ADMIN_OIDC_SUBJECTS` configuration. Do not use email addresses or client
input as the admin identity.

The foundation expects server-side `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`AUTH_SESSION_KEY`, `APP_ORIGIN`, `OIDC_REDIRECT_URI`, and
`ADMIN_OIDC_SUBJECTS` configuration. Supply these through the deployment's
secret/configuration manager. `AUTH_SESSION_KEY` must be a base64url encoding
of exactly 32 random bytes. The callback URI must share the configured app
origin. No credentials or session secrets are committed or defaulted by the
application.

The encrypted session cookie is HttpOnly, host-only, SameSite=Lax, and expires
after eight hours; production sets Secure. A separate SameSite=Strict CSRF
cookie is paired with the session token. Mutation handlers must require an
authenticated admin, verify the exact request Origin, and compare the CSRF
cookie and `X-CSRF-Token` header against the session claim.

Sessions are stateless and are not stored in MongoDB. Removing an admin from
the subject allowlist immediately denies new guarded requests, but a stolen
session cannot be individually revoked before its eight-hour expiry; rotating
`AUTH_SESSION_KEY` invalidates all sessions. Authentication unit tests validate
configuration, encrypted-session handling, authorization, and CSRF behavior;
they do not contact Google, exercise the live OIDC exchange, or verify
deployment configuration.

## MongoDB model and repository layer

Server-only Zod schemas, MongoDB document types, and explicit serializers are
defined in `src/lib/models.server.ts`. Participants are person identities with
unique normalized email addresses. Course enrollments are separate records
referencing a participant and template-independent course identity. The stable
`courseId` convention is a lowercase kebab-case slug (for example,
`web-foundations`); `courseName` on an enrollment is a display snapshot, not a
course-management record.

Certificate issuance is tied to a completed enrollment. Certificates retain
their enrollment, template, issue date, status, and revocation/reissue audit
fields. Verification identifiers, participant email, MongoDB internal fields,
and revocation reasons are not included in repository serializers. Enrollment
transitions are limited to `in_progress` -> `completed` or
`in_progress` -> `withdrawn`; completed and withdrawn states are terminal.
Model index creation is explicit through `createModelIndexes(database)` and is
not called at import, startup, or page-render time.

The server-only `src/lib/repositories.server.ts` module exposes lazy repository
operations through `createRepositories()`. It does not obtain the database
until an operation is called. Reissue is persisted in the
`certificateReissueWorkflows` collection and can be resumed by its idempotency
key. The workflow revokes the prior certificate before inserting the linked
replacement, and keeps an active-enrollment lock until the replacement is
confirmed and the workflow is completed. This avoids requiring MongoDB
transactions, but relies on the declared indexes being deployed to enforce
concurrency and uniqueness. Before requesting or resuming a reissue, the
repository verifies that the required unique index definitions are present;
otherwise it fails closed without changing records. The replacement document
uses a deterministic `_id` persisted in the workflow, so concurrent resumes
cannot insert two replacements even before relying on the secondary unique
workflow-link index.
Repository race tests use an in-memory mock configured with the declared index
metadata and simulate selected unique-key rejections and atomic document
updates. They exercise retry and interleaving logic, but do not prove MongoDB
deployment, server scheduling, or production concurrency guarantees; those
remain dependent on the required indexes being deployed and verified.
If replacement insertion encounters a certificate-ID or verification-ID
collision that is not the replacement already stored for that workflow, resume
fails safely and leaves the workflow locked for review. Resolve the conflicting
record through an explicitly reviewed operational procedure, preserving both
certificate histories. If the colliding record is valid, an authorized,
audited repair must rotate the workflow's not-yet-issued replacement
certificate and verification identifiers; automatic regeneration is not
performed. Do not delete history, clear the active lock, or reactivate the
previous certificate. Retry resume only after the repaired identifiers are
confirmed unique.

Manual revocation and workflow revocation compete through one atomic
certificate update conditioned on `status: "issued"` and no reissue revocation
marker. If manual revocation wins, the reissue workflow is cancelled and its
active lock is released; if reissue wins, manual revocation returns a conflict.
If the referenced template disappears after workflow creation, resumption
leaves the workflow pending at its current state and keeps the enrollment
locked. Restore the same template record and retry; do not manually reactivate
the old certificate or clear the lock.

## Legacy-data migration plan (not executed)

Existing participant documents contain both person and course data, while
existing certificates point directly to those participant records. The new
schemas do not reinterpret or remove those fields automatically. Before
deployment:

1. Build a read-only dry run that normalizes each legacy email and groups
   records into one participant per normalized email.
2. Report duplicate emails with inconsistent names and duplicate
   participant/course pairs. Resolve conflicts explicitly; do not choose a
   winner silently.
3. Create one enrollment for each legacy participant/course record, deriving
   a stable lowercase kebab-case `courseId` through an approved mapping and
   preserving the legacy course text as `courseName`. The dry-run output must
   explicitly report unknown or ambiguous course-ID mappings; resolve every
   such mapping before migration rather than guessing or collapsing courses.
   Map legacy
   `certificateStatus: "pending"` to `in_progress`; do not infer
   `completed` solely from legacy `certificateStatus: "issued"`. Reconcile that
   state against valid certificate records and other completion evidence, and
   flag cases that cannot be resolved.
4. Map each legacy certificate's `participantId` to its source legacy
   participant/course enrollment. Report and resolve missing references or
   ambiguous mappings.
   The dry-run report must also identify duplicate certificate IDs, duplicate
   verification identifiers, and certificates whose template reference is
   missing. Resolve each conflict or missing reference explicitly before
   migration; do not silently discard or remap historical records.
5. Preserve certificate IDs, verification identifiers, issue dates, status,
   template references, and available revocation information. Flag multiple
   active certificates for one enrollment for explicit resolution.
6. Review the dry-run report and obtain explicit production-migration
   approval. Back up the data, migrate in a separately reviewed process, then
   verify counts and references.
7. Check uniqueness conflicts, then explicitly approve and create the new
   indexes. The required indexes include unique participant email, unique
   participant/course enrollment, unique template name, unique certificate
   ID and verification identifier, and the partial unique active-certificate
   index. Reissue workflows also require unique idempotency keys, unique active
   enrollment locks, and unique replacement linkage.

No migration or index creation is run by the application or its tests. Existing
legacy indexes must be reviewed and removed or replaced only as part of the
approved migration plan.
#   T e c h S q u a d - C e r t i f i c a t e s  
 