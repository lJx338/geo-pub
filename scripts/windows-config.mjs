import packageJson from '../package.json' with { type: 'json' };

// Share the same identity and resources as existing Windows installations.
export default {
  ...packageJson.build,
  productName: 'Lingxi Workspace',
  nsis: { ...packageJson.build.nsis, shortcutName: 'Lingxi Workspace' },
};
