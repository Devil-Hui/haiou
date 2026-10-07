import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

// Pool size is the main knob that keeps a small server stable: every idle connection holds
// memory inside PostgreSQL, so a 2 GB box should run fewer than the default 10. docker-compose.yml
// raises DB_POOL_MAX on larger hosts. Invalid or out-of-range values fall back rather than failing startup.
const configured = Number(process.env.DB_POOL_MAX);
const max = Number.isInteger(configured) && configured > 0 && configured <= 50 ? configured : 10;

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: "aura-web",
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
