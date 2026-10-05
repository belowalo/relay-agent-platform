# Operations qualification evidence

Foundation: `76649286b51b39924261a876878efebf5e02f020`. The operational service is a synthetic infrastructure qualification harness, not the integrated Relay application. `runtimeIntegrated:false` is preserved in every report.

Evidence updates will record exact CI run, release commit, clean-container build, fault drills, restoration duration, integrity checks and scanner findings. Until the actual CI run is inspected, deployment and restoration gates remain pending. Local telemetry/health/redaction unit checks passed (4 tests). Local Docker Engine is unavailable because Docker Desktop reports an inaccessible stale inference socket; removal was rejected by automatic approval review.

Production readiness is blocked by the integration requirements listed in the operations handoff, regardless of infrastructure fixture results. No external staging or paid infrastructure was created.
