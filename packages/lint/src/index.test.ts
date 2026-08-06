import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const pluginPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const oxlintPath = resolve(process.cwd(), 'node_modules/.bin/oxlint');

const lint = (source: string, rule: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'durability-lint-'));
  const sourcePath = join(directory, 'fixture.ts');
  const configPath = join(directory, '.oxlintrc.json');
  writeFileSync(sourcePath, source);
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [{ name: 'durability', specifier: pluginPath }],
      rules: {
        'no-unused-vars': 'off',
        [`durability/${rule}`]: 'error',
      },
    })
  );

  try {
    const result = spawnSync(
      oxlintPath,
      ['--config', configPath, '--format', 'unix', sourcePath],
      { encoding: 'utf8' }
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('alarm-runner-only', () => {
  it('accepts a delegating durability alarm runner', () => {
    const result = lint(
      `
        class Example {
          durability = createDurability();
          alarm(alarmInfo?: AlarmInvocationInfo) {
            return this.durability.alarm(alarmInfo);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result).toEqual({ status: 0, output: '' });
  });

  it('rejects additional alarm runner code', () => {
    const result = lint(
      `
        class Example {
          durability = createDurability();
          alarm(alarmInfo?: AlarmInvocationInfo) {
            console.log('running');
            return this.durability.alarm(alarmInfo);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'A durability alarm runner must only return the durability alarm handler'
    );
  });

  it('accepts delegation to a shared DurabilityScheduler', () => {
    const result = lint(
      `
        class Example {
          private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
          private readonly jobs = new Durability({ scheduler: this.scheduler, handlers: {} });
          private readonly alarms = new DurabilityAlarms({ scheduler: this.scheduler, handlers: {} });
          alarm(alarmInfo?: AlarmInvocationInfo) {
            return this.scheduler.alarm(alarmInfo);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result).toEqual({ status: 0, output: '' });
  });

  it('requires delegation for a fanout capability', () => {
    const source = `class App {
      fanout = new DurabilityFanout({ context: this.ctx, targets: {} });
      alarm(info) { return this.fanout.alarm(info); }
    }`;
    expect(lint(source, 'alarm-runner-only').status).toBe(0);
    expect(
      lint(
        source.replace('this.fanout.alarm(info)', 'this.other.alarm(info)'),
        'alarm-runner-only'
      ).status
    ).toBe(1);
  });

  it('rejects alarm runners that bypass the attached helper', () => {
    const result = lint(
      `
        class Example {
          private readonly alarms = new DurabilityAlarms({ context: this.ctx, handlers: {} });
          alarm(alarmInfo?: AlarmInvocationInfo) {
            return this.other.alarm(alarmInfo);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result.status).toBe(1);
  });
  it('rejects a durability class without an alarm runner', () => {
    const result = lint(
      `
        class Example {
          durability = createDurability();
        }
      `,
      'alarm-runner-only'
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'A class using createDurability must delegate alarm() directly to durability.alarm(alarmInfo).'
    );
  });

  it.each(['setAlarm', 'deleteAlarm'])(
    'rejects direct %s calls in a durability class',
    (method) => {
      const result = lint(
        `
          class Example {
            durability = createDurability();
            alarm(alarmInfo?: AlarmInvocationInfo) {
              return this.durability.alarm(alarmInfo);
            }
            schedule() {
              return this.ctx.storage.${method}(1000);
            }
          }
        `,
        'alarm-runner-only'
      );

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        'A class using createDurability must schedule logical alarms through durability named alarms instead of calling setAlarm() or deleteAlarm().'
      );
    }
  );

  it('rejects transaction alarm writes in a durability class', () => {
    const result = lint(
      `
        class Example {
          durability = createDurability();
          alarm(alarmInfo?: AlarmInvocationInfo) {
            return this.durability.alarm(alarmInfo);
          }
          schedule() {
            return this.ctx.storage.transaction((transaction) => {
              transaction.setAlarm(1000);
            });
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'A class using createDurability must schedule logical alarms through durability named alarms instead of calling setAlarm() or deleteAlarm().'
    );
  });

  it('accepts named logical alarms in a durability class', () => {
    const result = lint(
      `
        class Example {
          durability = createDurability();
          alarm(alarmInfo?: AlarmInvocationInfo) {
            return this.durability.alarm(alarmInfo);
          }
          schedule() {
            return this.durability.alarm.cleanup(1000);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result).toEqual({ status: 0, output: '' });
  });

  it('ignores physical alarm calls in classes without durability', () => {
    const result = lint(
      `
        class Example {
          alarm() {
            return this.ctx.storage.setAlarm(1000);
          }
        }
      `,
      'alarm-runner-only'
    );

    expect(result).toEqual({ status: 0, output: '' });
  });
});

describe('durability-migrations-only', () => {
  it('accepts the durability migration table', () => {
    const result = lint(
      `
        import { DOQB } from 'workers-qb';
        const qb = new DOQB(storage.sql);
        qb.migrations({
          migrations,
          tableName: 'durability_migrations',
        });
      `,
      'durability-migrations-only'
    );

    expect(result).toEqual({ status: 0, output: '' });
  });

  it.each([
    `
      import type { DurableMigrations } from '@durability/storage';
      const migrations = [{
        name: '0001_create_jobs',
        up: \`CREATE TABLE jobs (id TEXT PRIMARY KEY);\`,
        down: 'DROP TABLE jobs;',
      }] satisfies DurableMigrations;
    `,
    `
      import type { DurableMigrations as MigrationList } from '@durability/storage';
      const migrations: MigrationList = [{
        name: '0001_create_jobs',
        up: 'create table jobs (id TEXT PRIMARY KEY);',
        down: 'DROP TABLE jobs;',
      }];
    `,
    `
      import type { DurableMigrations as MigrationList } from '@durability/storage';
      const migrations = [{
        name: '0001_create_jobs',
        up: 'CREATE ' + ('TEMP ' + 'TABLE jobs (id TEXT);'),
        down: \`CREATE \${'TEMP' + 'ORARY'}   TABLE backup (id TEXT);\`,
      }] satisfies MigrationList;
    `,
  ])('accepts tables declared in durable migrations', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result).toEqual({ status: 0, output: '' });
  });

  it.each([
    `
      class Example {
        constructor(readonly ctx: DurableObjectState) {
          ctx.storage.sql.exec(\`CREATE TABLE jobs (id TEXT PRIMARY KEY);\`);
        }
      }
    `,
    `
      import type { Migration } from 'workers-qb';
      const migrations: Migration[] = [{
        name: '0001_create_jobs',
        sql: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
      }];
    `,
    `
      import type { DurableMigrations as MigrationList } from '@durability/storage';
      function applicationMigrations() {
        type MigrationList = Array<{ sql: string }>;
        const migrations: MigrationList = [{
          sql: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
        }];
        return migrations;
      }
    `,
  ])('rejects tables outside durable migrations', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'CREATE TABLE statements must be declared in DurableMigrations.'
    );
  });

  it.each([
    `'CREATE ' + ('TABLE ' + 'jobs (id TEXT PRIMARY KEY);');`,
    '`CREATE ${`TEMP`}\n\tTABLE jobs (id TEXT PRIMARY KEY);`;',
    '`create ${"TEMP" + "ORARY"} table jobs (id TEXT PRIMARY KEY);`;',
    "('CREATE ' as const) + ('TABLE jobs (id TEXT PRIMARY KEY);' as const);",
  ])('reports the outermost static SQL expression once', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result.status).toBe(1);
    expect(
      result.output.match(
        /CREATE TABLE statements must be declared in DurableMigrations\./g
      ) ?? []
    ).toHaveLength(1);
  });

  it.each([
    `
      const table = 'jobs';
      const sql = \`CREATE TABLE \${table} (id TEXT PRIMARY KEY);\`;
    `,
    `
      const statement = 'CREATE ' + operation;
      execute(statement);
    `,
  ])('ignores SQL expressions that cannot be statically resolved', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result).toEqual({ status: 0, output: '' });
  });

  it.each([
    `
      import { DOQB } from 'workers-qb';
      const qb = new DOQB(storage.sql);
      qb.migrations({ migrations });
    `,
    `
      import { DOQB as QueryBuilder } from 'workers-qb';
      new QueryBuilder(storage.sql).migrations({
        migrations,
        tableName: 'migrations',
      });
    `,
    `
      import { DOQB as QueryBuilder } from 'workers-qb';
      let builder;
      builder = new QueryBuilder(storage.sql);
      builder.migrations({ migrations });
    `,
    `
      import { DOQB } from 'workers-qb';
      class Example {
        qb = new DOQB(storage.sql);
        migrate() {
          this.qb.migrations({ migrations });
        }
      }
    `,
    `
      import { DOQB as QueryBuilder } from 'workers-qb';
      class Example {
        #qb = new QueryBuilder(storage.sql);
        migrate() {
          this.#qb.migrations({ migrations, tableName: 'other' });
        }
      }
    `,
    `
      import { DOQB } from 'workers-qb';
      class Example {
        private qb: DOQB;
        constructor() {
          this.qb = new DOQB(storage.sql);
        }
        migrate() {
          this.qb.migrations({ migrations });
        }
      }
    `,
  ])('rejects a non-durability workers-qb migration table', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'workers-qb migrations must use the durability_migrations table.'
    );
  });

  it.each([
    `
      const qb = createApplicationQueryBuilder();
      qb.migrations({ migrations });
    `,
    `
      import { DOQB } from 'another-package';
      const qb = new DOQB(storage.sql);
      qb.migrations({ migrations });
    `,
    `
      import { DOQB } from 'workers-qb';
      function migrate(DOQB: new (...args: unknown[]) => unknown) {
        const qb = new DOQB(storage.sql);
        qb.migrations({ migrations });
      }
    `,
    `
      import { DOQB } from 'workers-qb';
      const qb = new DOQB(storage.sql);
      function migrate(qb: { migrations: (value: unknown) => void }) {
        qb.migrations({ migrations });
      }
    `,
    `
      import { DOQB } from 'workers-qb';
      let qb = new DOQB(storage.sql);
      qb = createApplicationQueryBuilder();
      qb.migrations({ migrations });
    `,
    `
      import { DOQB } from 'workers-qb';
      class Example {
        qb = createApplicationQueryBuilder();
        migrate() {
          this.qb.migrations({ migrations });
        }
      }
    `,
  ])('ignores unrelated migration builders', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result).toEqual({ status: 0, output: '' });
  });
});
