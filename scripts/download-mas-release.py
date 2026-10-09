"""Download an existing MAS release package and verify its GitHub SHA-256."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def select_package(release, tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Use a stable release tag, for example v0.6.1')
    if release.get('isDraft') or release.get('tagName') != tag:
        raise ValueError('Expected the requested published release')
    packages = [asset for asset in release['assets'] if asset['name'].endswith('.pkg')]
    if len(packages) != 1:
        raise ValueError('The release must contain exactly one Mac App Store .pkg')
    package = packages[0]
    pattern = rf'Lingxi-Workspace-{re.escape(tag[1:])}-mas-\d+\.\d+-arm64\.pkg'
    if not re.fullmatch(pattern, package['name']):
        raise ValueError('The package name does not match this MAS release')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', package.get('digest') or ''):
        raise ValueError('The release asset must have a GitHub SHA-256 digest')
    return package


def main():
    tag = os.environ['RELEASE_TAG']
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Use a stable release tag, for example v0.6.1')
    repository = os.environ['GITHUB_REPOSITORY']
    release = json.loads(subprocess.check_output([
        'gh', 'release', 'view', tag, '--repo', repository,
        '--json', 'assets,tagName,isDraft',
    ], text=True))
    package = select_package(release, tag)
    directory = Path(tempfile.mkdtemp(prefix='mas-upload-', dir=os.environ['RUNNER_TEMP']))
    subprocess.run([
        'gh', 'release', 'download', tag, '--repo', repository,
        '--pattern', package['name'], '--dir', str(directory),
    ], check=True)
    path = directory / package['name']
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    if path.stat().st_size != package['size'] or f'sha256:{digest.hexdigest()}' != package['digest']:
        raise ValueError('Downloaded package does not match the published release asset')
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as handle:
        handle.write(f'MAS_PKG_PATH={path}\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
        handle.write(f'Package: `{package["name"]}`\n\nSHA-256: `{digest.hexdigest()}`\n\n')
    print(f'Verified release package: {package["name"]}')


if __name__ == '__main__':
    main()
