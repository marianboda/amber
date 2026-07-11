// Shared Postgres connection for tests. Points at a local dev database (see
// README: `docker run … postgres:16`); override with TEST_DATABASE_URL. Each
// test file opens its own schema so suites are isolated and can run in parallel.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5455/amber";
