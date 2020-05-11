// @flow
import type {Config, PluginOptions} from '@parcel/types';
import path from 'path';

import preset from '@babel/preset-react';

const JSX_EXTENSIONS = {
  '.jsx': true,
  '.tsx': true,
};

const JSX_PRAGMA = {
  react: {
    pragma: 'React.createElement',
    pragmaFrag: 'React.Fragment',
  },
  preact: {
    pragma: 'h',
    pragmaFrag: 'Fragment',
  },
  nervjs: {
    pragma: 'Nerv.createElement',
    pragmaFrag: undefined,
  },
  hyperapp: {
    pragma: 'h',
    pragmaFrag: undefined,
  },
};

/**
 * Generates a babel config for JSX. Attempts to detect react or react-like libraries
 * and changes the pragma accordingly.
 */
export default async function getJSXOptions(
  options: PluginOptions,
  config: Config,
) {
  if (!config.isSource) {
    return null;
  }

  let pkg = await config.getPackage();
  let reactLib;
  if (pkg?.alias && pkg.alias['react']) {
    // e.g.: `{ alias: { "react": "preact/compat" } }`
    reactLib = 'react';
  } else {
    // Find a dependency that we can map to a JSX pragma
    reactLib = Object.keys(JSX_PRAGMA).find(
      libName =>
        pkg &&
        ((pkg.dependencies && pkg.dependencies[libName]) ||
          (pkg.devDependencies && pkg.devDependencies[libName])),
    );
  }

  let pragma = reactLib ? JSX_PRAGMA[reactLib].pragma : undefined;
  let pragmaFrag = reactLib ? JSX_PRAGMA[reactLib].pragmaFrag : undefined;

  if (pragma || JSX_EXTENSIONS[path.extname(config.searchPath)]) {
    return {
      presets: [
        [
          preset,
          {pragma, pragmaFrag, development: options.mode === 'development'},
        ],
      ],
    };
  }
}
