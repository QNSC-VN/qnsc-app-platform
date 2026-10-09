import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` needs no database. The auth tables come from `auth generate`
// (src/db/schema.ts is that output with uuid ids in an `identity` schema, see the header there).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['identity'],
});
