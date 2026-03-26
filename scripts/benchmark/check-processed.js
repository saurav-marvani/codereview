#!/usr/bin/env node
/**
 * Check if a PR was processed by querying automation_execution in Postgres.
 * Usage: node check-processed.js <prNumber>
 * Outputs: "true" or "false"
 */
const { execSync } = require('child_process');
const fs = require('fs');

const prNumber = parseInt(process.argv[2]);
if (!prNumber) { console.log('false'); process.exit(0); }

try {
    const sql = `SELECT COUNT(*) FROM automation_execution ae JOIN code_review_execution cre ON cre.automation_execution_id = ae.uuid WHERE ae."pullRequestNumber" = ${prNumber} AND cre.stage_name = 'Kody Review Finished' AND cre.status = 'success'`;
    fs.writeFileSync('/tmp/pg_benchmark_query.sql', sql);
    const result = execSync('docker exec -i db_postgres psql -U kodusdev -d kodus_db -t -A < /tmp/pg_benchmark_query.sql', { encoding: 'utf8', timeout: 10000 }).trim();
    console.log(parseInt(result) > 0 ? 'true' : 'false');
} catch {
    console.log('false');
}
