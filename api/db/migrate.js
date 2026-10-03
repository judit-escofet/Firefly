// Runs schema.sql against TIGER_DATABASE_URL:  node db/migrate.js
const fs = require('fs');
const path = require('path');
const { getPool } = require('./index');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await getPool().query(sql);
  console.log('Schema applied.');
  await getPool().end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
