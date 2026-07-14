# @durability/lint

Oxlint-only rules for Durable Object durability integrations.

```json
{
  "jsPlugins": [{ "name": "durability", "specifier": "@durability/lint" }],
  "rules": {
    "durability/alarm-runner-only": "error",
    "durability/durability-migrations-only": "error"
  }
}
```

- `alarm-runner-only` requires a class using `durability` to delegate its alarm method directly to `durability.alarm(...)` with no other statements.
- `durability-migrations-only` requires every `CREATE TABLE` statement to live in a list typed with `DurableMigrations`. It also requires `workers-qb` migration builders to use `tableName: 'durability_migrations'`. Unrelated migration-builder APIs are ignored.
