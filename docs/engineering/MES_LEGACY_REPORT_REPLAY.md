# Preserve MES report retries during offline migration

The legacy reporting endpoint stores the retry key as its request hash. The
Go station instead hashes the authenticated actor and canonical report
command. Reusing the legacy hash would make valid retries fail, and
dropping the retry entry could duplicate a committed report.

## Program boundaries

- Keep the default refusal for legacy retry rows. Require an explicitly
  reviewed mapping from each legacy report actor to a usable MES station
  account in the same organization. The first supported mapping preserves
  the actor ID and relies on a pre-enrolled station account with an enabled
  write grant. Never infer identity from a demo cookie or role name.
- Validate that a legacy key and successful cached response identify exactly
  one committed report in the same organization. Cross-check the report ID,
  item counts, work order and operation, and validate the saved aggregate
  quantities and status. A missing or ambiguous record aborts the import.
- Reconstruct the Go command from the report and use the validated account
  ID to compute its native fingerprint. Convert the cached response to the
  Go field names and preserve its historical totals. Retain the original
  report, audit and source archive. Conflicting native retry keys abort
  publication.
- A successful native replay must return the migrated result without a new
  report. A changed actor or payload must not use the migrated result.

## Remote acceptance

Use the real offline importer with synthetic source SQLite files. Test
explicit account mapping, mismatched cached data, and a conflicting native
retry key. Exercise the migrated fingerprint and response through the Go
report route before the migration can be used with a production source.
The observed source currently has no enrolled MES station accounts.
