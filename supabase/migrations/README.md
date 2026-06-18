# Migrations

The first SQL migration must be generated from the linked Supabase database:

```powershell
npm run db:connect:real
```

Do not reconstruct the baseline from `src/lib/database.types.ts`. That file is not a schema
source of truth. Review the generated SQL for tables, constraints, indexes, RLS policies,
functions, extensions, and Realtime publication membership before adding feature migrations.

MVP-0a does not add a placeholder SQL migration because an empty or guessed baseline would make
`supabase db reset` appear reproducible when it is not.

After the baseline exists, add MVP-0b migrations after the generated baseline migration. Do not
edit the baseline by hand except to remove accidental secrets or non-repeatable local artifacts.
