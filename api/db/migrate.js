// Runs schema.sql against TIGER_DATABASE_URL:  node db/migrate.js
// If the variable isn't set, it's read from api/local.settings.json (git-ignored).
const fs = require('fs');
const path = require('path');

if (!process.env.TIGER_DATABASE_URL) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local.settings.json'), 'utf8'));
    process.env.TIGER_DATABASE_URL = settings.Values && settings.Values.TIGER_DATABASE_URL;
  } catch {
    // fall through to the check below
  }
}
const url = process.env.TIGER_DATABASE_URL;
if (!url) {
  console.error('Set TIGER_DATABASE_URL in api/local.settings.json (or the environment).');
  process.exit(1);
}
try {
  if (!new URL(url).password) {
    console.error('TIGER_DATABASE_URL has no password. Use postgres://tsdbadmin:PASSWORD@host:port/tsdb?sslmode=verify-full');
    process.exit(1);
  }
} catch {
  console.error('TIGER_DATABASE_URL is not a valid URL. If the password has special characters, URL-encode them.');
  process.exit(1);
}

const { getPool } = require('./index');

(async () => {
  // One statement at a time: continuous aggregates can't be created inside a transaction,
  // and a multi-statement query runs as one implicit transaction.
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  for (const statement of sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    await getPool().query(statement);
  }
  const { rows } = await getPool().query(
    `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
  );
  console.log('Schema applied. Hypertables:', rows.map((r) => r.hypertable_name).join(', '));
  await getPool().end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
