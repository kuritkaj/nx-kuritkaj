import { StartRepoExecutorSchema } from './schema';
import {
  ExecutorContext,
  logger,
  ProjectGraph,
  ProjectGraphProjectNode,
  workspaceRoot,
} from '@nx/devkit';
import { existsSync, rmSync } from 'fs-extra';
import { ChildProcess, execSync, fork } from 'child_process';
import { join, resolve } from 'path';
import { default as npmConf } from '@pnpm/npm-conf';
import { getPackageJson } from '@nx/eslint-plugin/src/utils/package-json-utils';
import * as fs from 'fs';
import yaml from 'js-yaml';

let childProcess: ChildProcess;

function isNpmScopeName(name: string) {
  return name.startsWith('@');
}

function getNpmScopeFromName(name: string) {
  if (!isNpmScopeName(name)) {
    return null;
  }

  return name.split('/')[0].substring(1);
}

function getPackageJsonScopeIfExists(path: string) {
  if (!fs.existsSync(path)) {
    return null;
  }

  const packageJson = getPackageJson(path);
  if (!packageJson) {
    return null;
  }

  return getNpmScopeFromName(packageJson.name) || null;
}
function getRootNpmScope() {
  const rootPackageJsonPath = join(workspaceRoot, 'package.json');
  return getPackageJsonScopeIfExists(rootPackageJsonPath);
}

const getNodeFilePath = (node: ProjectGraphProjectNode, fileName: string) => {
  return join(workspaceRoot, node.data.root, fileName);
};

function getNodePackageJsonPath(node: ProjectGraphProjectNode) {
  return getNodeFilePath(node, 'package.json');
}

const isLibNode = (node: ProjectGraphProjectNode) => node.type === 'lib';

const isNodeWithPackageJson = (node: ProjectGraphProjectNode) => {
  const nodePackageJsonPath = getNodePackageJsonPath(node);

  return fs.existsSync(nodePackageJsonPath);
};

const isLibNodeWithPackageJson = (node: ProjectGraphProjectNode) => {
  return isLibNode(node) && isNodeWithPackageJson(node);
};

const getNodeNpmScope = (node: ProjectGraphProjectNode) => {
  const nodePackageJsonPath = getNodePackageJsonPath(node);
  return getPackageJsonScopeIfExists(nodePackageJsonPath);
};

const getProjectNodes = (projectGraph: ProjectGraph) =>
  Object.values(projectGraph.nodes);

function getNpmScopesFromProjectNodes(projectNodes: ProjectGraphProjectNode[]) {
  const libNodes = projectNodes.filter(isLibNodeWithPackageJson);
  return libNodes.map(getNodeNpmScope);
}

const removeDuplicates = (arr: string[]) => [...new Set(arr)];

function removeEmptyString(scopes: string[]) {
  return scopes.filter((s) => Boolean(s?.trim()));
}

const removeDuplicatesAndEmptyScopes = (scopes: string[]) => {
  const filtered = removeEmptyString(scopes);
  return removeDuplicates(filtered);
};

function getWorkspaceNpmScopes(projectGraph: ProjectGraph) {
  const projectScopes = getNpmScopesFromProjectNodes(
    getProjectNodes(projectGraph)
  );
  const rootScope = getRootNpmScope();

  return removeDuplicatesAndEmptyScopes([...projectScopes, rootScope]);
}

const getLocalRegistrySettings = (port) => {
  const hostAndPort = `localhost:${port}/`;

  return {
    registry: `http://${hostAndPort}`,
    authTokenKey: `//${hostAndPort}:_authToken`,
    authTokenValue: 'secretVerdaccioToken',
  };
};

const writeYaml = (file, data) => {
  //Convert JSON to Yaml
  const yamlData = yaml.dump(data, {
    indent: 2,
    noRefs: true,
  });

  //Save to file
  fs.writeFileSync(file, yamlData, 'utf8');
};

class NpmConfManager {
  originalConf = null;
  originalValuesForLocations = new Map<string, Map<string, any>>();

  constructor() {
    this.originalConf = npmConf().config;
  }

  get(name: string, location: string = undefined) {
    return this.originalConf.get(name, location);
  }

  getForLocation(name: string, location: string) {
    return {
      value: this.get(name),
      locationValue: this.get(name, location),
    };
  }

  set(name: string, value: string, location: string = undefined) {
    this.storeOriginalValue(name, location);

    if (!value) {
      logger.info(`delete ${name} ${location}`);
      execSync(`npm config delete ${name} --location ${location}`);
    } else {
      logger.info(`set ${name} ${value} ${location}`);
      execSync(`npm config set ${name}=${value} --location ${location}`);
    }
  }
  restore(location: string) {
    logger.info(`restore .npmrc for ${location}`);

    const vals = this.getLocationOriginalValues(location);

    [...vals.entries()].forEach(([name, value]) => {
      this.set(name, value, location);
    });
  }

  restoreAll() {
    const locs = this.originalValuesForLocations.keys();
    for (const loc of locs) {
      this.restore(loc);
    }
  }

  getLocationOriginalValues = (location: string = undefined) => {
    if (!this.originalValuesForLocations.has(location)) {
      this.originalValuesForLocations.set(location, new Map());
    }

    return this.originalValuesForLocations.get(location);
  };

  storeOriginalValue = (name: string, location: string = undefined) => {
    const locationValues = this.getLocationOriginalValues(location);

    if (locationValues.has(name)) {
      return;
    }

    logger.info(
      `storeOriginalValue ${name} ${this.get(name, location)} ${location}`
    );
    locationValues.set(name, this.get(name, location));
  };
}

interface NpmConfItem {
  name: string;
  key: string;
}

const npmRegistry: NpmConfItem = {
  name: 'npm',
  key: 'registry',
};

function createScopedRegistryConfigItem(s): NpmConfItem {
  return {
    name: s,
    key: `@${s}:registry`,
  };
}

function mapNpmScopesToConfItems(npmScopes: string[]) {
  return npmScopes.map(createScopedRegistryConfigItem);
}

function getNpmRegistriesConfig(
  context: ExecutorContext,
  conf: NpmConfManager,
  options: StartRepoExecutorSchema
) {
  const npmScopes = getWorkspaceNpmScopes(context.projectGraph);

  return [...mapNpmScopesToConfItems(npmScopes), npmRegistry].map(
    ({ name, key }) => {
      const { value, locationValue } = conf.getForLocation(
        key,
        options.location
      );

      return {
        name,
        key,
        value,
        locationValue,
      };
    }
  );
}

function createVerdaccioConfig(
  npmRegistryConfig: {
    name: string;
    key: string;
    value: any;
    locationValue: any;
  }[]
) {
  const verdaccioUplinks = npmRegistryConfig.reduce((acc, { name, value }) => {
    if (!value) {
      return acc;
    }

    acc[name] = {
      url: value,
    };

    return acc;
  }, {});

  const verdaccioPackages = npmRegistryConfig.reduce(
    (acc, { name, key, value }) => {
      const packageKey = key === 'registry' ? '**' : `@${name}/*`;

      if (!value) {
        return acc;
      }

      const packageConf = {
        access: '$all',
        publish: '$all',
        unpublish: '$all',
        proxy: name,
      };

      acc[packageKey] = packageConf;

      return acc;
    },
    {}
  );

  return {
    storage: '../tmp/local-registry/storage',
    uplinks: verdaccioUplinks,
    packages: verdaccioPackages,
    log: {
      type: 'stdout',
      format: 'pretty',
      level: 'debug',
    },
    publish: {
      allow_offline: true,
    },
    middlewares: {
      audit: {
        enabled: true,
      },
    },
  };
}

function configureNpm(
  npmRegistryConfig: {
    name: string;
    value: any;
    key: string;
    locationValue: any;
  }[],
  conf: NpmConfManager,
  registryConfig: {
    registry: string;
    authTokenKey: string;
    authTokenValue: string;
  },
  options: StartRepoExecutorSchema
) {
  npmRegistryConfig.forEach(({ key }) => {
    conf.set(key, registryConfig.registry, options.location);
  });

  conf.set(
    registryConfig.authTokenKey,
    registryConfig.authTokenValue,
    options.location
  );
}

export default async function runExecutor(
  options: StartRepoExecutorSchema,
  context: ExecutorContext
) {
  try {
    require.resolve('verdaccio');
  } catch (e) {
    throw new Error(
      'Verdaccio is not installed. Please run `npm install verdaccio` or `yarn add verdaccio`'
    );
  }

  if (options.storage) {
    options.storage = resolve(context.root, options.storage);
    if (options.clear && existsSync(options.storage)) {
      rmSync(options.storage, { recursive: true, force: true });
      logger.info(`Cleared local registry storage folder ${options.storage}`);
    }
  }

  const conf = new NpmConfManager();

  const registryConfig = getLocalRegistrySettings(options.port);

  const npmRegistryConfig = getNpmRegistriesConfig(context, conf, options);
  const verdaccionConfig = createVerdaccioConfig(npmRegistryConfig);

  const configFile = join(workspaceRoot, '.verdaccio/generated_config.yaml');
  options.config = configFile;

  logger.info({
    options,
    registryConfig,
    npmRegistryConfig,
  });

  logger.info(`Verdaccio configuration: ${configFile}`);
  logger.info(verdaccionConfig);

  writeYaml(configFile, verdaccionConfig);

  configureNpm(npmRegistryConfig, conf, registryConfig, options);

  const processExitListener = async (signal?: number | NodeJS.Signals) => {
    if (childProcess) {
      childProcess.kill(signal);
    }
    try {
      conf.restoreAll();
    } catch (e) {
      console.error(e);
    }
  };

  process.on('exit', processExitListener);
  process.on('SIGTERM', processExitListener);
  process.on('SIGINT', processExitListener);
  process.on('SIGHUP', processExitListener);

  try {
    await startVerdaccio(options);
  } catch (e) {
    logger.error('Failed to start verdaccio: ' + e?.toString());
    return {
      success: false,
      port: options.port,
    };
  }
  return {
    success: true,
    port: options.port,
  };
}

/**
 * Fork the verdaccio process: https://verdaccio.org/docs/verdaccio-programmatically/#using-fork-from-child_process-module
 */
function startVerdaccio(options: StartRepoExecutorSchema) {
  return new Promise((resolve, reject) => {
    childProcess = fork(
      require.resolve('verdaccio/bin/verdaccio'),
      createVerdaccioOptions(options),
      {
        env: {
          ...process.env,
          VERDACCIO_HANDLE_KILL_SIGNALS: 'true',
          ...(options.storage
            ? { VERDACCIO_STORAGE_PATH: options.storage }
            : {}),
        },
        stdio: 'inherit',
      }
    );

    childProcess.on('error', (err) => {
      reject(err);
    });
    childProcess.on('disconnect', (err) => {
      reject(err);
    });
    childProcess.on('exit', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(code);
      }
    });
  });
}

function createVerdaccioOptions(options: StartRepoExecutorSchema) {
  const verdaccioArgs: string[] = [];
  if (options.port) {
    verdaccioArgs.push('--listen', options.port.toString());
  }
  if (options.config) {
    verdaccioArgs.push('--config', options.config);
  }
  return verdaccioArgs;
}

