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
      'A durability alarm runner must only return durability.alarm(alarmInfo).'
    );
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
  ])('ignores unrelated migration builders', (source) => {
    const result = lint(source, 'durability-migrations-only');

    expect(result).toEqual({ status: 0, output: '' });
  });
});
