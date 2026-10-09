import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { signAsync } from '@electron/osx-sign';

export default async function signMas(options) {
  if (options.platform !== 'mas' || !options.identity) throw new Error('Expected signed MAS configuration');
  const args = [fileURLToPath(new URL('./sign-mas-libraries.py', import.meta.url)), options.app, options.identity];
  if (options.keychain) args.push('--keychain', options.keychain);
  const { stdout, stderr } = await promisify(execFile)('python3', args);
  if (stderr) process.stderr.write(stderr);
  const libraries = new Set(JSON.parse(stdout));
  const existingIgnore = options.ignore == null ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore];
  // Preserve electron-builder's executable entitlements, profile embedding,
  // identity and strict verification. Only shared code was signed separately.
  await signAsync({
    ...options,
    ignore: [...existingIgnore, (file) => libraries.has(realpathSync(file))],
  });
}
