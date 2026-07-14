/**
 * Ordered, reversible SQLite migrations owned by a durability package.
 *
 * Durability helpers share a Durable Object database with application data, so
 * each helper owns a namespaced migration history instead of using the host
 * application's migration table. Reversible entries let a helper move to an
 * explicit schema target without coordinating application migrations.
 *
 * @example
 * ```ts
 * const migrations = [
 *   {
 *     name: 'queue_0001_create_jobs',
 *     up: 'CREATE TABLE queue_jobs (id TEXT PRIMARY KEY);',
 *     down: 'DROP TABLE queue_jobs;',
 *   },
 * ] satisfies DurableMigrations;
 * ```
 */
export type DurableMigrations = readonly {
  /** Stable migration identifier. */
  name: string;
  /** SQL that applies the migration. */
  up: string;
  /** SQL that reverts the migration. */
  down: string;
}[];
