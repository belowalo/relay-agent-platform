# Integration qualification record

Status: **qualification in progress; main must not be merged**.

The integration branch merges the actual runtime, security, knowledge, connectors,
operations and verification implementations. The production composition lives in
`server/production`, rather than loading the local SQLite router. It connects
PostgreSQL tenant repositories, separate identity/rate/dispatch roles, encrypted
credential references, durable BullMQ dispatch, CPU embeddings, S3 documents,
isolated parser service, exact approvals and provider accounting.

Source heads:

| Team         | Commit                                   |
| ------------ | ---------------------------------------- |
| Runtime      | da1699d116cad8adf70a09b1732881f909f82b15 |
| Connectors   | 0c2912761cd2caf88a3ece7e37229761e718de32 |
| Knowledge    | bd2cbf2e0dda35eb19e190ee84ae520104f525b2 |
| Security     | 85319812d8bd4328aa95330753803b982e29f073 |
| Operations   | 06e1cd56446f392c904baf98697f3750f1314c19 |
| Verification | cbcd551204ece8e6bc3f14d0ad785f34c664d34b |

Semantic repairs include freezing tool configuration at publication, ignoring
untrusted supplied snapshots, mapping runtime permissions to security operations,
settling provider reservations with reported usage, keeping Preview free of model
calls and external actions, preserving exact approval hashes in the UI, and
making migration dry runs exercise destination constraints before rollback.

The combined local build and regression run passed 125 tests with six service
checks skipped. Embedded PostgreSQL migration tests cover rollback, preserved
IDs, credential rewrapping, vector dimension rejection and SQL role grants.
These are development evidence, not a deployment or live model quality verdict.
The exact release commit and CI evidence will be recorded after qualification.

The local Docker engine remains unavailable. Disposable Linux CI is configured
to exercise real PostgreSQL, Redis and S3 with the actual production modules.
Its model/action endpoints are synthetic protocol fixtures and do not establish
live service quality. The existing operations harness uses a synthetic application
and is not evidence that the integrated production application was deployed.

Unqualified gates currently include actual integrated container deployment and
restore, two-host recovery, the declared load and one-hour soak targets, a held-out
live-model/document corpus with human review, and complete production UI/API
journeys. Infrastructure scans and operating instructions must be reconciled
with actual tested configurations. No supported company capacity is claimed yet.
