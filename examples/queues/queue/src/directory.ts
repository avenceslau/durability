import { DurableObject } from 'cloudflare:workers';

/** The list of queues, for the dashboard's first page. One instance. */
export class Directory extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS queues (
         name TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL
       )`
    );
  }

  add(name: string): void {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO queues (name, created_at) VALUES (?, ?)',
      name,
      Date.now()
    );
  }

  remove(name: string): void {
    this.ctx.storage.sql.exec('DELETE FROM queues WHERE name = ?', name);
  }

  list(): { name: string; createdAt: number }[] {
    return this.ctx.storage.sql
      .exec<{ name: string; created_at: number }>(
        'SELECT name, created_at FROM queues ORDER BY name'
      )
      .toArray()
      .map((row) => ({ name: row.name, createdAt: row.created_at }));
  }
}
