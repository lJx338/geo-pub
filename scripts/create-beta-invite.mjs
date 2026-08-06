import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const code = String(process.argv[2] || '').trim().toUpperCase();
const outputDirectory = process.argv[3] || 'beta-invites';

if (!/^BETA-[A-Z0-9]{6,32}$/.test(code)) {
  throw new Error('Usage: node scripts/create-beta-invite.mjs BETA-XXXXXX [output-directory]');
}

const hash = createHash('sha256').update(code).digest('hex');
const payload = {
  channel: 'beta',
  createdAt: new Date().toISOString(),
};

await mkdir(outputDirectory, { recursive: true });
const path = join(outputDirectory, `${hash}.json`);
await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ code, hash, path, objectKey: `geo-publisher/invites/${hash}.json` }, null, 2)}\n`);
