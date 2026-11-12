# MES BOM revision

BOM versions referenced by work orders are historical production inputs.
Revise a BOM by copying its materials into the existing create-version form
and saving the edited draft under a new version. The source version and work
order references stay intact.

## Feature boundary

The back office lists source versions for the selected product and loads
their lines into a browser draft. The operator can edit quantities, remove
lines and add new materials. The existing create endpoint remains responsible
for organization scope, permissions, idempotency, unique versions and cycle
validation. Draft changes affect stored data only after a successful save.

## Acceptance

Create a revision from an existing version, change a quantity, save it and
verify both versions and their distinct quantities. Reload and verify that
an existing work order still points to its original BOM version.
