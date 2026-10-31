# Development test accounts

For **local development and testing only**. Created (or reset) by:

```bash
npm run seed:dev
```

Sign in at http://localhost:5180/login.

**Password for every account:** `LocalLens-dev-pass-2026`

| Email | Roles | Use it to test |
|---|---|---|
| `reader@locallens.test` | reader | Reading, following, saving |
| `reporter@locallens.test` | reader, reporter | Submitting stories (Phase 3) |
| `editor@locallens.test` | reader, editor | Creating and publishing articles |
| `admin@locallens.test` | reader, admin | Users page: roles, reporter approvals, password resets, suspension |
| `qa-reader@locallens.test` | reader | Created through the sign-up page during the full feature check (30 Oct 2026); follows Guntur, has one saved story |

Safety: the command refuses to run with `NODE_ENV=production` or against a non-local `MONGODB_URI`, so these accounts
can never exist in a shared or deployed database. Re-running it resets them (password, roles, active status).
`.test` is a reserved top-level domain, so these addresses can never belong to a real person.
