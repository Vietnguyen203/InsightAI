// Creates the PostgreSQL roles and base schema InsightAI expects. Idempotent: safe to re-run.
//
// Role names and passwords are taken from the connection URLs themselves, so `.env` stays the
// single source of truth. Requires DATABASE_ADMIN_URL (a superuser or a role with CREATEROLE).
// Never run this against production without review: it (re)sets role passwords.
//
//   owner     (DATABASE_MIGRATE_URL)   owns schema "app", runs migrations
//   app       (DATABASE_URL)           DML on "app", subject to RLS (NOBYPASSRLS)
//   analytics (DATABASE_ANALYTICS_URL) no privileges of its own; may only SET ROLE to tenant readers
//   ingest    (DATABASE_INGEST_URL)    no privileges of its own; may only SET ROLE to tenant writers
//   provisioner (DATABASE_PROVISIONER_URL) CREATEROLE + CREATE SCHEMA: creates tenant schemas/roles
//               and grants them to analytics/ingest. No access to the metadata schema.
import pg from 'pg';

const required = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATE_URL',
  'DATABASE_URL',
  'DATABASE_ANALYTICS_URL',
  'DATABASE_INGEST_URL',
  'DATABASE_PROVISIONER_URL',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

function credentials(name) {
  const url = new URL(process.env[name]);
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

const owner = credentials('DATABASE_MIGRATE_URL');
const app = credentials('DATABASE_URL');
const analytics = credentials('DATABASE_ANALYTICS_URL');
const ingest = credentials('DATABASE_INGEST_URL');
const provisioner = credentials('DATABASE_PROVISIONER_URL');
const database = new URL(process.env.DATABASE_ADMIN_URL).pathname.replace(/^\//, '');

const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();

const id = (value) => client.escapeIdentifier(value);
const lit = (value) => client.escapeLiteral(value);

async function ensureRole({ user, password }, attributes) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
  const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
  await client.query(`${verb} ROLE ${id(user)} WITH LOGIN PASSWORD ${lit(password)} ${attributes}`);
  console.log(`${verb === 'CREATE' ? 'created' : 'updated'} role ${user}`);
}

try {
  await client.query('BEGIN');

  await ensureRole(owner, 'NOSUPERUSER NOBYPASSRLS');
  await ensureRole(app, 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB');
  // NOINHERIT: membership in tenant roles grants nothing until an explicit SET ROLE.
  await ensureRole(analytics, 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT');
  await ensureRole(ingest, 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT');
  // PostgreSQL 16+: a CREATEROLE role may only administer the roles it created itself.
  await ensureRole(provisioner, 'NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOINHERIT');

  await client.query(`GRANT CONNECT, CREATE ON DATABASE ${id(database)} TO ${id(owner.user)}`);
  await client.query(
    `GRANT CONNECT, CREATE ON DATABASE ${id(database)} TO ${id(provisioner.user)}`,
  );
  for (const role of [app, analytics, ingest]) {
    await client.query(`GRANT CONNECT ON DATABASE ${id(database)} TO ${id(role.user)}`);
  }

  await client.query(`CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ${id(owner.user)}`);
  await client.query(`ALTER SCHEMA app OWNER TO ${id(owner.user)}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA public TO PUBLIC`); // extension functions live here
  await client.query(`GRANT USAGE ON SCHEMA app TO ${id(app.user)}`);

  // Tables created later by migrations (as owner) are automatically usable by the app role.
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner.user)} IN SCHEMA app
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${id(app.user)}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(owner.user)} IN SCHEMA app
       GRANT USAGE, SELECT ON SEQUENCES TO ${id(app.user)}`,
  );

  await client.query('COMMIT');
  console.log(`bootstrap complete for database "${database}"`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('bootstrap failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
