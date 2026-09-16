import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(version)) {
  throw new Error('Usage: node scripts/set-version.mjs <major.minor.patch[-alpha.N|-beta.N]>');
}

async function updateJson(path, update) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  update(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

await updateJson('package.json', (value) => { value.version = version; });
await updateJson('package-lock.json', (value) => {
  value.version = version;
  if (value.packages?.['']) value.packages[''].version = version;
});
await updateJson('integrations/workbuddy/geo-publisher/package.json', (value) => { value.version = version; });

const goPath = 'cli/main.go';
const goSource = await readFile(goPath, 'utf8');
const updatedGo = goSource.replace(/var version = "[^"]+"/, `var version = "${version}"`);
if (updatedGo === goSource) throw new Error('Could not update CLI version');
await writeFile(goPath, updatedGo);

process.stdout.write(`Updated desktop, CLI, lockfile, and Skill to ${version}\n`);
