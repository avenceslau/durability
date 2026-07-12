export type DurableMigrations = readonly {
  name: string;
  up: string;
  down: string;
}[];
