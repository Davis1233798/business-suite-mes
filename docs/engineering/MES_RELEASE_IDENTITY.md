# MES release identity

## Architecture and boundary

The isolated MES health endpoint currently proves readiness but does not identify the executable release. Add an immutable build-time full Git SHA to its public ready response. It is public source identity, not a credential. Unknown or malformed values become `unknown`; runtime request headers and environment variables cannot claim a different build.

The MES source archive deployment passes its already validated release SHA as a Docker build argument. The GitHub image publication must pass the same checked-out head SHA. Preserve the existing health envelope, authentication policy and database behavior. No migration or public route change is part of this feature.

## Tests before code

Port the existing main portfolio revision unit/health test into the independent MES repository. Extend the isolated deployment integration test to compare the health revision with the SHA it archived, including rollback to the prior revision. Remote Linux Go race and container tests execute in GitHub; do not run local application tests/builds.

## Acceptance

An OCI release is verified only when externally observed health identifies the intended SHA. Successful GHCR publication alone is insufficient. Existing unknown builds remain readable and must not be presented as verified deployments.
