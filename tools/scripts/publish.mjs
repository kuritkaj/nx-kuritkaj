/**
 * This is a minimal script to publish your package to "npm".
 * This is meant to be used as-is or customize as you see fit.
 *
 * This script is executed on "dist/path/to/library" as "cwd" by default.
 *
 * You might need to authenticate with NPM before running this script.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

import devkit from '@nx/devkit';
import path from "path";
const { readCachedProjectGraph } = devkit;

function invariant(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

// Executing publish script: node path/to/publish.mjs {name} --version {version} --tag {tag}
// Default "tag" to "next" so we won't publish the "latest" tag by accident.
const [, , name] = process.argv;

const graph = readCachedProjectGraph();
const project = graph.nodes[name];

invariant(
  project,
  `Could not find project "${name}" in the workspace. Is the project.json configured correctly?`
);

const outputPath = project.data?.targets?.build?.options?.outputPath;
invariant(
  outputPath,
  `Could not find "build.options.outputPath" of project "${name}". Is project.json configured  correctly?`
);

const packageJsonFile = path.join(outputPath, 'package.json');

// Updating the version in "package.json" before publishing
try {
  const tag = "dev";
  const json = JSON.parse(readFileSync(packageJsonFile).toString());
  const packageName = json.name;
  const devVersion = json.version.endsWith(`-${tag}`) ? json.version : `${json.version}-${tag}`;

  json.version = devVersion;
  writeFileSync(packageJsonFile, JSON.stringify(json, null, 2));

  // Execute "npm publish" to publish
  execSync(`npm unpublish --force ${packageName}@${devVersion} || true`);
  execSync(`npm publish --tag ${tag} ${outputPath}`);

} catch (e) {
  console.error(`Error reading package.json file from library build output.`, e);
}
