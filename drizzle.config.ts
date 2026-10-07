import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Environment first, so `npx drizzle-kit push` targets exactly the database the app talks to.
// The local fallback keeps the previous out-of-the-box behaviour when DATABASE_URL is unset.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" },
});
