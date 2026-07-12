# @durability/storage

Exports only the `DurableMigrations` type used to define reversible durability migrations.

```ts
import type { DurableMigrations } from '@durability/storage';

const migrations = [
  {
    name: '0001_example',
    up: 'CREATE TABLE example ...',
    down: 'DROP TABLE example',
  },
] satisfies DurableMigrations;
```
