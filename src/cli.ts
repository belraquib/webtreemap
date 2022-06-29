#!/usr/bin/env node

/**
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Command, Option} from 'commander';
import {promises as fs} from 'fs';
import open from 'open';
import {processDir} from './processors/du';
import {processJsonSpaceUsage} from './processors/json';

import * as tree from './tree';
import {collectInputFromArgs, ProcessorFn, writeToTempFile} from './util';
import {Options as TreemapOptions} from './treemap';

function parseLine(line: string): [string, number] {
  if (line.match(/^\s*$/)) {
    // Skip blank / whitespace-only lines
    return ['', 0];
  }

  // Match (number)(whitespace)(path)
  let m = line.match(/(\S+)\s+(.*)/);
  if (m) {
    const [, sizeStr, path] = m;
    const size = Number(sizeStr);
    if (isNaN(size)) {
      throw new Error(`Unable to parse ${size} as a number in line: "${line}"`);
    }
    return [path, size];
  }

  // Assume it's (path)
  return [line, 1];
}

/** Constructs a tree from an array of path / size pairs. */
function treeFromRows(
  rows: readonly [string, number, number?][],
  doRollup: boolean
): tree.Node {
  let node = tree.treeify(rows);

  // If there's a common empty parent, skip it.
  if (node.id === undefined && node.children && node.children.length === 1) {
    node = node.children[0];
  }

  // If there's an empty parent, roll up for it.
  if (node.size === 0 && node.children) {
    for (const c of node.children) {
      node.size += c.size;
    }
  }

  if (doRollup) {
    tree.rollup(node);
  }

  tree.sort(node);
  tree.flatten(node);

  return node;
}

const processSizePathPairs: ProcessorFn = async args => {
  const text = await collectInputFromArgs(args);
  return text.split('\n').map(parseLine);
};

const processSizeValuePathTuple: ProcessorFn = async args => {
  // Parses text of the form
  // <num> <path1>
  // <num> <path2>
  // [[ value delimeter ]]
  // <num> <path1>
  // <num> <path2>
  const text = await collectInputFromArgs(args);
  const results: [string, number, number?][] = [];
  const ptrs = new Map<string, [string, number, number?]>();
  let foundValueDelimeter = false;
  for (const line of text.split('\n')) {
    // A value delimeter looks like [[ text ]]. The text isn't
    // used directly. Any entries after this will be assumed
    // to be all or a subset of the entries in the initial lines.
    // Any new paths discovered after the delimeter are ignored.
    if (line.match(/\[\[(.*)\]\]/)) {
      foundValueDelimeter = true;
      continue;
    }
    const newLineData = parseLine(line);
    if (!foundValueDelimeter) {
      ptrs.set(newLineData[0], newLineData);
      results.push(newLineData);
      continue;
    }
    const sizeLineData = ptrs.get(newLineData[0]);
    if (sizeLineData) {
      sizeLineData[2] = newLineData[1];
    } else {
      // No size entry found, add a new entry with a size of zero.
      results.push([newLineData[0], 0, newLineData[1]]);
    }
  }
  if (results.length === 0) {
    return results;
  }
  if (foundValueDelimeter && results[0].length === 2) {
    // Add a signal that we expect values.
    results[0][2] = undefined;
  }
  return results;
};

function colorizeNode(n: tree.Node, options: TreemapOptions) {
  // Colors the node value between the min and max color. Assumes
  // that the value is in the range [0,1]
  if (!options.hasValues) {
    return;
  }
  if (!n.dom) {
    return;
  }
  if (!n.value) {
    // grey ish
    n.dom.style.backgroundColor = 'rgba(150,150,150,1)';
    return;
  }

  // rgb(239,179,179) - red - minColor
  // rgb(217,247,217) - green - maxColor
  const r = (217 - 239) * n.value + 239;
  const g = (247 - 179) * n.value + 179;
  const b = (217 - 179) * n.value + 179;
  n.dom.style.backgroundColor = `rgba(${r},${g},${b},1)`;
}

function humanSizeCaption(n: tree.Node, options: TreemapOptions): string {
  let units = ['', 'k', 'm', 'g'];
  let unit = 0;
  let size = n.size;
  while (size > 1024 && unit < units.length - 1) {
    size = size / 1024;
    unit++;
  }
  const numFmt =
    unit === 0 && size === Math.floor(size)
      ? '' + size // Prefer "1" to "1.0"
      : size.toFixed(1) + units[unit];
  if (options.hasValues) {
    if (n.value === undefined) {
      return `${n.id || ''} (NONE, ${numFmt})`;
    } else if (n.value) {
      return `${n.id || ''} (${n.value.toFixed(2)}, ${numFmt})`;
    }
  }

  return `${n.id || ''} (${numFmt})`;
}

function formatText(rootNode: tree.Node): string {
  const lines: string[] = [];
  const help = (node: tree.Node, prefix: string) => {
    const path = prefix + (node.id ?? '');
    if (node.value) {
      lines.push(`${node.value},${node.size}\t${path}`);
    } else {
      lines.push(`${node.size}\t${path}`);
    }
    node.children?.forEach(child => help(child, path + '/'));
  };
  help(rootNode, '');
  return lines.join('\n');
}

type OutputFormat = 'html' | 'json' | 'text';

async function main() {
  const program = new Command()
    .description(
      `Generate web-based treemaps.

  Reads a series of
    size path
  lines from stdin, splits path on '/' and outputs HTML for a treemap.
`
    )
    .option('-o, --output [path]', 'output to file, not stdout')
    .addOption(
      new Option('-f, --format [format]', 'Set output format').choices([
        'html',
        'json',
        'text',
      ])
    )
    .option('--title [string]', 'title of output HTML')
    .option('--no-rollup', 'Skips the rollup step')
    .option('--no-ignore-small', 'Ignores small area nodes')
    .parse(process.argv);

  const args = program.opts();
  let processor = processSizePathPairs;
  const arg0 = program.args[0];
  let hasValues = false;
  if (arg0 === 'du') {
    processor = processDir;
    program.args.shift();
  } else if (arg0 === 'du:json') {
    processor = processJsonSpaceUsage;
    program.args.shift();
  } else if (arg0 === 'with-values') {
    processor = processSizeValuePathTuple;
    program.args.shift();
    hasValues = true;
  }

  const rows = await processor(program.args);
  const node = treeFromRows(rows, args.rollup);
  const treemapJS = await fs.readFile(__dirname + '/webtreemap.js', 'utf-8');
  const title = args.title || 'webtreemap';

  let outputFormat = args.format as OutputFormat | undefined;
  if (!outputFormat) {
    const output = args.output as string | undefined;
    outputFormat = output?.endsWith('.json')
      ? 'json'
      : output?.endsWith('.txt')
      ? 'text'
      : 'html';
  }

  let output: string;
  if (outputFormat === 'html') {
    const showSmallOptsSnippet = !args.ignoreSmall
      ? `    showChildren: (() => true),
    lowerBound: 0,
`
      : '';
    output = `<!doctype html>
<title>${title}</title>
<style>
html, body {
  height: 100%;
}
body {
  font-family: sans-serif;
  margin: 0;
}
#treemap {
  top: 10px;
  bottom: 10px;
  left: 10px;
  right: 10px;
  position: absolute;
  cursor: pointer;
  -webkit-user-select: none;
}
</style>
<div id='treemap'></div>
<script>const data = ${JSON.stringify(node)}</script>
<script>${treemapJS}</script>
<script>
function render() {
  webtreemap.render(document.getElementById("treemap"), data, {
    caption: ${humanSizeCaption},
    applyMutations: ${colorizeNode},
    hasValues: ${hasValues},
    ${showSmallOptsSnippet}
  });
}
window.addEventListener('resize', render);
render();
</script>
`;
  } else if (outputFormat === 'json') {
    output = JSON.stringify(node, null, 2);
  } else if (outputFormat === 'text') {
    output = formatText(node);
  } else {
    throw new Error(
      `Unknown output format: ${outputFormat}, expected "html" or "json".`
    );
  }

  if (args.output) {
    await fs.writeFile(args.output, output, {encoding: 'utf-8'});
  } else if (!process.stdout.isTTY || outputFormat !== 'html') {
    console.log(output);
  } else {
    open(await writeToTempFile(output));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
