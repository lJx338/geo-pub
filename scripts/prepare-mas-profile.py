"""Validate only public profile fields. Never print secret values or decoded certificates."""
import base64
import datetime
import os
from pathlib import Path
import plistlib
import subprocess

required = ['MAS_CSC_LINK', 'MAS_CSC_KEY_PASSWORD', 'MAS_CSC_INSTALLER_LINK',
            'MAS_CSC_INSTALLER_KEY_PASSWORD', 'MAS_PROVISIONING_PROFILE']
for name in required:
    if not os.environ.get(name, '').strip():
        raise SystemExit('Missing GitHub Actions secret: ' + name)
profile_path = Path(os.environ['MAS_PROFILE_PATH'])
profile = base64.b64decode(''.join(os.environ['MAS_PROVISIONING_PROFILE'].split()), validate=True)
profile_path.write_bytes(profile)
# This public, Apple-signed profile is copied into the installed app. It must
# remain readable by normal users; it does not contain our signing private key.
profile_path.chmod(0o644)
decoded = subprocess.check_output(['security', 'cms', '-D', '-i', str(profile_path)], stderr=subprocess.PIPE)
info = plistlib.loads(decoded)
entitlements = info['Entitlements']
assert info['TeamIdentifier'] == ['F8X7472LW9'], 'Wrong profile team'
assert entitlements['com.apple.application-identifier'] == 'F8X7472LW9.com.lingxi.geo-publisher', 'Wrong Bundle ID'
assert 'OSX' in info['Platform'], 'Profile must be for macOS'
assert info['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Expired profile'
assert not entitlements.get('get-task-allow') and not entitlements.get('com.apple.security.get-task-allow'), 'Development profile supplied'
assert not info.get('ProvisionedDevices') and not info.get('ProvisionsAllDevices'), 'App Store distribution profile required'
print('Mac App Store profile team, application, type and expiration verified.')
