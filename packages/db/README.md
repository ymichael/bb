# @bb/db

## Migration Workflow

Schema changes must be checked in as generated SQL migrations:

```sh
pnpm --filter @bb/db db:generate
```

Review the generated SQL before committing it. `db:push` is intentionally not
exposed for this package because it mutates the target database directly and can
hide migration drift in persistent BB data directories.
