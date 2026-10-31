/**
 * Imports villages (with their states, districts and mandals) from an official LGD CSV export.
 *
 *   npm run locations:import -- --file data/lgd/ap-villages.csv --district 506 --dry-run
 *   npm run locations:import -- --file data/lgd/all-villages-of-india.csv            (all ~6.5 lakh villages)
 *   npm run locations:import -- --file data/lgd/all-villages-of-india.csv --state 28  (one state)
 *
 * Record the file's source URL, download date and SHA-256 in data/lgd/MANIFEST.md (see docs/data-sources/locations-lgd.md).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectDatabase, disconnectDatabase } from '../db';
import { AuditEventModel } from '../modules/audit/audit';
import { importLgd } from '../modules/geo/lgd-import';

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: { file: { type: 'string' }, district: { type: 'string' }, state: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const uri = process.env.MONGODB_URI;
  if (!values.file || !uri) {
    console.error('Usage: npm run locations:import -- --file <csv> [--state <LGD code>] [--district <LGD code>] [--dry-run]   (MONGODB_URI must be set)');
    process.exit(2);
  }
  const text = await readFile(values.file, 'utf8');
  await connectDatabase(uri);
  try {
    const dryRun = values['dry-run'] ?? false;
    const started = Date.now();
    const summary = await importLgd(text, {
      districtCode: values.district,
      stateCode: values.state,
      dryRun,
      onProgress: (done, total) => process.stdout.write(`\r  villages: ${done.toLocaleString('en-IN')} / ${total.toLocaleString('en-IN')}`),
    });
    process.stdout.write(`\n  took ${Math.round((Date.now() - started) / 1000)} s\n`);
    console.log(dryRun ? 'DRY RUN — nothing was written.' : 'Import complete.');
    console.log(JSON.stringify(summary, null, 2));
    if (!dryRun) await AuditEventModel.create({ action: 'geo.lgd_imported', metadata: { file: values.file, ...summary } });
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && /import-lgd\.(ts|js)$/.test(process.argv[1])) {
  await cli();
}
