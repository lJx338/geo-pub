import packageJson from '../package.json' with { type: 'json' };

export function masConfig(env = process.env) {
  const version = env.MAS_APP_VERSION || '1.0';
  const buildNumber = env.MAS_BUILD_NUMBER || '1';
  if (!/^[1-9]\d*\.\d+(?:\.\d+)?$/.test(version)) throw new Error('MAS_APP_VERSION must be numeric, for example 1.0');
  if (!/^[1-9]\d*(?:\.\d+){0,2}$/.test(buildNumber)) throw new Error('Invalid MAS_BUILD_NUMBER');
  if (!env.MAS_PROFILE_PATH) throw new Error('MAS_PROFILE_PATH is required');
  return {
    ...packageJson.build,
    directories: { output: 'release/mas' },
    files: ['dist/**/*', '!dist/cli/**/*', 'package.json'],
    // Keep internal name and existing DMG settings; these overrides apply only to this build.
    extraMetadata: { version: version.split('.').length === 2 ? `${version}.0` : version },
    artifactName: `Lingxi-Workspace-${version}-mas-${buildNumber}-\${arch}.\${ext}`,
    publish: null,
    mac: { ...packageJson.build.mac, target: [{ target: 'mas', arch: ['arm64'] }], notarize: false },
    mas: {
      type: 'distribution',
      hardenedRuntime: false,
      forceCodeSigning: true,
      entitlements: 'build/entitlements.mas.plist',
      entitlementsInherit: 'build/entitlements.mas.inherit.plist',
      entitlementsLoginHelper: 'build/entitlements.mas.loginhelper.plist',
      provisioningProfile: env.MAS_PROFILE_PATH,
      binaries: ['Contents/Resources/cli/geo-publisher-darwin-arm64'],
      bundleShortVersion: version,
      bundleVersion: buildNumber,
      extendInfo: { ElectronTeamID: 'F8X7472LW9' },
    },
  };
}
