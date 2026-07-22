# Prisma migrate history (PostgreSQL)

SQL migrations in this folder apply to **PostgreSQL** only.

```bash
npx prisma migrate deploy --schema=src/prisma/schema.prisma
# or during local dev:
npx prisma migrate dev --schema=src/prisma/schema.prisma
```

`db push` also works against Postgres for quick schema sync.
