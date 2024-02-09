import { RunExecutorSchema } from './schema';

import {
  createProjectGraphAsync,
  ExecutorContext,
  getOutputsForTargetAndConfiguration,
  logger,
  ProjectGraphExternalNode,
  ProjectGraphProjectNode,
  workspaceRoot,
  writeJsonFile,
} from '@nx/devkit';
import {
  calculateProjectDependencies,
  DependentBuildableProjectNode,
} from '@nx/js/src/utils/buildable-libs-utils';
import {
  createDirectory,
  directoryExists,
} from '@nx/workspace/src/utils/fileutils';
import { copyFileSync, lstatSync, readdirSync } from 'fs';
import { EOL } from 'os';
import { join } from 'path';
import validate from 'validate-npm-package-name';
import { getHelperDependenciesFromProjectGraph } from '@nx/js';
import {
  getAllDependencies,
  getPackageJson,
} from '@nx/eslint-plugin/src/utils/package-json-utils';
import { PackageJson } from 'nx/src/utils/package-json';

type BundableLibDependency = {
  projectName: string;
  packageName: string;
  validPackageName: boolean;
  isScoped: boolean;
  distPath: string;
  npmDeps: string[];
};

function getRootPackageJsonDeps() {
  const rootPackageJsonPath = join(workspaceRoot, 'package.json');
  const rootPackageJson = getPackageJson(rootPackageJsonPath);

  return getAllDependencies(rootPackageJson);
}

const isLibNode = (
  dependency: DependentBuildableProjectNode
): dependency is DependentBuildableProjectNode & {
  node: ProjectGraphProjectNode;
} => dependency.node.type === 'lib';
const isNpmPackage = (
  dependency: DependentBuildableProjectNode
): dependency is DependentBuildableProjectNode & {
  node: ProjectGraphExternalNode;
} => dependency.node.type === 'npm';

function getProjectDependencies(context: ExecutorContext) {
  const {
    target,
    nonBuildableDependencies,
    dependencies,
    topLevelDependencies,
  } = calculateProjectDependencies(
    context.projectGraph,
    context.root,
    context.projectName,
    'build',
    context.configurationName
  );

  const deps = [...dependencies, ...topLevelDependencies];

  function getProjectHelperNpmDeps(projectName: string) {
    // we have to add the project itself as its dependency
    // otherwise the fucking getHelperDependenciesFromProjectGraph fn
    // will return an empty array, because it checks only project dependencies which are libs
    // but not the project itself
    const betterProjectGraph = {
      ...context.projectGraph,
      dependencies: {
        ...context.projectGraph.dependencies,
        [projectName]: [
          { source: projectName, target: projectName, type: 'static' },
          ...context.projectGraph.dependencies[projectName],
        ],
      },
    };

    const helperDependencies = getHelperDependenciesFromProjectGraph(
      context.root,
      projectName,
      betterProjectGraph
    );

    return helperDependencies.map(
      (helperDep) => helperDep.target.split('npm:')[1] || ''
    );
  }

  // split deps in two arrays by this condition: dependency.node.type === "lib"
  const libDeps: BundableLibDependency[] = deps
    .filter(isLibNode)
    .map((dep) => {
      const packageName = dep.name;
      const projectName = dep.node.name;

      return {
        projectName,
        packageName,
        validPackageName: validate(packageName).validForNewPackages,
        isScoped: isScoped(projectName),
        distPath: dep.outputs[0],
        npmDeps: [],
      };
    })
    .filter((dep) => dep.validPackageName);

  const npmDeps = deps
    .filter(isNpmPackage)
    .map((dep) => dep.node.data.packageName);

  const projectHelperDeps = getProjectHelperNpmDeps(context.projectName);
  const helperNmpDeps = libDeps.flatMap((d) => d.npmDeps);

  const combinedNpmDeps = [
    ...new Set([...npmDeps, ...projectHelperDeps, ...helperNmpDeps]),
  ];

  const rootNpmDeps = getRootPackageJsonDeps();
  const npmDepsWithVersions = combinedNpmDeps.map((d) => ({
    packageName: d,
    version: rootNpmDeps[d],
  }));

  return {
    target,
    libDeps,
    npmDeps: npmDepsWithVersions,
    nonBuildableDependencies,
    dependencies,
    topLevelDependencies,
  };
}

interface NpmPackageDependency {
  packageName: string;
  version: string;
}

interface ProjectInfoPlusPlus {
  distPath: string;
  distPackageJson: PackageJson;
  distNodeModulesPath: string;
  distPackageJsonPath: string;
  publishPath: string;
  publishPackageJson: PackageJson;
  publishNodeModulesPath: string;
  publishPackageJsonPath: string;
  libDeps: BundableLibDependency[];
  npmDeps: NpmPackageDependency[];
  target: ProjectGraphProjectNode;
}

function getProjectInfoPlusPlus(
  context: ExecutorContext,
  options: RunExecutorSchema
): ProjectInfoPlusPlus {
  const { target, libDeps, npmDeps } = getProjectDependencies(context);

  const outputs = getOutputsForTargetAndConfiguration(
    {
      overrides: {},
      target: {
        project: context.projectName,
        target: 'build',
        configuration: context.configurationName,
      },
    },
    target
  );

  const distPath = outputs[0];
  const distPackageJsonPath = join(distPath, 'package.json');
  const distPackageJson = getPackageJson(distPackageJsonPath);
  const distNodeModulesPath = join(distPath, 'node_modules');

  const publishPath = options.outputPath;

  logger.info(`${EOL} Copy ${distPath} => ${publishPath}`);
  copyFolderSync(distPath, publishPath);

  const publishPackageJsonPath = join(publishPath, 'package.json');
  const publishPackageJson = getPackageJson(publishPackageJsonPath);
  const publishNodeModulesPath = join(publishPath, 'node_modules');

  return {
    target,
    libDeps,
    npmDeps,
    distPath,
    distPackageJsonPath,
    distPackageJson,
    distNodeModulesPath,
    publishPath,
    publishPackageJsonPath,
    publishPackageJson,
    publishNodeModulesPath,
  };
}

export default async function runExecutor(
  options: RunExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectGraph = await createProjectGraphAsync();
  const newContext = {
    ...context,
    projectGraph,
  };

  const projectInfoPlusPlus = getProjectInfoPlusPlus(newContext, options);
  logger.info(`${EOL} Project info:`);
  logger.info(`${EOL} ${JSON.stringify(projectInfoPlusPlus, null, 2)}`);

  try {
    updateDependencies2(projectInfoPlusPlus);
  } catch (e) {
    return {
      success: false,
    };
  }

  return {
    success: true,
  };
}

export function updateDependencies2(projectInfo: ProjectInfoPlusPlus): boolean {
  const {
    publishPackageJson,
    publishPackageJsonPath,
    publishNodeModulesPath,
    libDeps,
    npmDeps,
  } = projectInfo;

  const packageJson = {
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    bundleDependencies: [],
    ...publishPackageJson,
  };

  function addDependency(
    npmDep: NpmPackageDependency,
    destination: 'dependencies' | 'bundledDependencies'
  ) {
    logger.info(
      `${EOL} Adding "${destination}" dependency: ${npmDep.packageName}`
    );

    if (destination === 'bundledDependencies') {
      packageJson.bundleDependencies.push(npmDep.packageName);
      addDependency(npmDep, 'dependencies');
      return;
    }

    packageJson[destination][npmDep.packageName] = npmDep.version;
  }

  libDeps.forEach((dependency) => {
    if (hasDependency(packageJson, dependency.packageName)) {
      return;
    }

    logger.info(`${EOL} Adding project dependency ${dependency.projectName}`);
    logger.info(
      `${EOL} Copy ${dependency.distPath} => ${join(
        publishNodeModulesPath,
        dependency.packageName
      )}`
    );

    copyFolderSync(
      dependency.distPath,
      join(publishNodeModulesPath, dependency.packageName)
    );

    const { version } = getPackageJson(
      join(publishNodeModulesPath, dependency.packageName, 'package.json')
    );

    addDependency(
      {
        packageName: dependency.packageName,
        version,
      },
      'bundledDependencies'
    );
  });

  npmDeps.forEach((dependency) => {
    if (hasDependency(packageJson, dependency.packageName)) {
      return;
    }
    addDependency(dependency, 'dependencies');
  });

  logger.info(`${EOL} Writing package.json to ${publishPackageJsonPath}`);
  logger.info(`${EOL} ${JSON.stringify(packageJson, null, 2)}`);

  writeJsonFile(publishPackageJsonPath, packageJson);

  return true;
}

// verify whether the package.json already specifies the dependencies
function hasDependency(outputJson, dep: string) {
  const deps = Object.keys(outputJson.dependencies);
  const peerDeps = Object.keys(outputJson.peerDependencies || {});
  const optionalDeps = Object.keys(outputJson.optionalDependencies || {});
  const devDeps = Object.keys(outputJson.devDependencies || {});

  const depNames = new Set([...deps, ...peerDeps, ...optionalDeps, ...devDeps]);

  return depNames.has(dep);
}

// checks whether the package name is scoped (e.g @foo/bar)
function isScoped(name: string) {
  const regex = '@[a-z\\d][\\w-.]+/[a-z\\d][\\w-.]*';
  return new RegExp(`^${regex}$`, 'i').test(name);
}

function copyFolderSync(from: string, to: string) {
  if (!directoryExists(to)) {
    createDirectory(to);
  }
  readdirSync(from).forEach((element: string) => {
    if (lstatSync(join(from, element)).isFile()) {
      try {
        copyFileSync(join(from, element), join(to, element));
      } catch (e) {
        logger.error(
          `${EOL} Could not copy ${join(from, element)} to ${join(to, element)}`
        );
        throw new Error();
      }
    } else {
      copyFolderSync(join(from, element), join(to, element));
    }
  });
}
