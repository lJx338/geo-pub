"""Download a MAS release or successful build artifact and verify its SHA-256."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile


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


def select_artifact(run, artifacts, repository):
    if (run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('path') != '.github/workflows/build-mas.yml'
            or run.get('head_repository', {}).get('full_name') != repository):
        raise ValueError('Expected a successful Build Mac App Store run in this repository')
    matches = [item for item in artifacts if re.fullmatch(
        rf'Lingxi-Workspace-MAS-\d+\.\d+\.\d+-{run["run_number"]}', item['name'])]
    if len(matches) != 1:
        raise ValueError('The run must contain exactly one MAS artifact')
    artifact = matches[0]
    if artifact.get('expired') or not re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest') or ''):
        raise ValueError('Expected an unexpired artifact with a GitHub SHA-256 digest')
    return artifact


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download_build(run_id, repository):
    if not re.fullmatch(r'[1-9]\d*', run_id):
        raise ValueError('build_run_id must be a positive integer')
    endpoint = f'repos/{repository}/actions/runs/{run_id}'
    run = json.loads(subprocess.check_output(['gh', 'api', endpoint], encoding='utf-8'))
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp', f'{endpoint}/artifacts',
    ], encoding='utf-8'))
    artifact = select_artifact(run, [item for page in pages for item in page['artifacts']], repository)
    directory = Path(tempfile.mkdtemp(prefix='mas-upload-', dir=os.environ['RUNNER_TEMP']))
    archive = directory / 'artifact.zip'
    with archive.open('wb') as handle:
        subprocess.run(['gh', 'api', f'repos/{repository}/actions/artifacts/{artifact["id"]}/zip'],
                       stdout=handle, check=True)
    if f'sha256:{sha256(archive)}' != artifact['digest']:
        raise ValueError('Downloaded artifact does not match its GitHub SHA-256 digest')
    version = artifact['name'].removeprefix('Lingxi-Workspace-MAS-').rsplit('-', 1)[0]
    name = f'Lingxi-Workspace-{version}-mas-{run["run_number"]}.{run["run_attempt"]}-arm64.pkg'
    path = directory / name
    with zipfile.ZipFile(archive) as bundle:
        packages = [item for item in bundle.infolist() if not item.is_dir() and item.filename.endswith('.pkg')]
        if len(packages) != 1 or Path(packages[0].filename).name != name:
            raise ValueError('Artifact must contain exactly the expected MAS package')
        # Copy only the expected member to a fixed basename; never extract archive paths.
        with bundle.open(packages[0]) as source, path.open('wb') as target:
            shutil.copyfileobj(source, target)
    publish_path(path)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
        handle.write(f'Source build: `{run_id}`; commit: `{run["head_sha"]}`\n\n')


def publish_path(path):
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as handle:
        handle.write(f'MAS_PKG_PATH={path}\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
        handle.write(f'Package: `{path.name}`\n\nSHA-256: `{sha256(path)}`\n\n')
    print(f'Verified package: {path.name}')


def main():
    tag = os.environ.get('RELEASE_TAG', '').strip()
    run_id = os.environ.get('BUILD_RUN_ID', '').strip()
    if bool(tag) == bool(run_id):
        raise ValueError('Specify exactly one of release_tag or build_run_id')
    repository = os.environ['GITHUB_REPOSITORY']
    if run_id:
        download_build(run_id, repository)
        return
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Use a stable release tag, for example v0.6.1')
    release = json.loads(subprocess.check_output([
        'gh', 'release', 'view', tag, '--repo', repository,
        '--json', 'assets,tagName,isDraft',
    ], encoding='utf-8'))
    package = select_package(release, tag)
    directory = Path(tempfile.mkdtemp(prefix='mas-upload-', dir=os.environ['RUNNER_TEMP']))
    subprocess.run([
        'gh', 'release', 'download', tag, '--repo', repository,
        '--pattern', package['name'], '--dir', str(directory),
    ], check=True)
    path = directory / package['name']
    if path.stat().st_size != package['size'] or f'sha256:{sha256(path)}' != package['digest']:
        raise ValueError('Downloaded package does not match the published release asset')
    publish_path(path)


if __name__ == '__main__':
    main()
