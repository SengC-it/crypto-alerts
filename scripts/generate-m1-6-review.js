import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  M16_ACCEPTED_REPORTS,
  buildM16Markdown,
  buildM16Report,
} from '../src/v2/m16ProfitabilityFeasibility.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = {};
const reportFileHashes = {};

for (const [stage, relativePath] of Object.entries(M16_ACCEPTED_REPORTS)) {
  const absolutePath = path.join(root, relativePath);
  const bytes = fs.readFileSync(absolutePath);
  reports[stage] = JSON.parse(bytes.toString('utf8'));
  reportFileHashes[relativePath] = crypto.createHash('sha256').update(bytes).digest('hex');
}

const sourceSha = process.env.M16_SOURCE_SHA ?? 'UNCOMMITTED';
const review = buildM16Report({ reports, reportFileHashes, sourceSha });
fs.writeFileSync(path.join(root, 'reports/m1-6-profitability-feasibility.json'), `${JSON.stringify(review, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'docs/m1-6-profitability-feasibility.md'), buildM16Markdown(review));
console.log(JSON.stringify({ report_hash: review.report_hash, decision: review.decision, source_sha: review.source_sha }));
