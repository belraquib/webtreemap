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
function treeFromRows(rows: readonly [string, number, number?][]): tree.Node {
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

  tree.rollup(node);
  tree.sort(node);
  tree.flatten(node);

  return node;
}

const processSizePathPairs: ProcessorFn = async args => {
  const text = await collectInputFromArgs(args);
  return text.split('\n').map(parseLine);
};

const processSizeValuePathPairs: ProcessorFn = async args => {
  const text = await collectInputFromArgs(args);
  const results = [];
  const ptrs = new Map<string, [string, number, number?]>();
  let d = '';
  for (const line of text.split('\n')) {
    let mm = line.match(/\[\[(.*)\]\]/);
    if (mm) {
      const [, dim] = mm;
      console.log(dim);
      d = dim;
      continue;
    }
    const x = parseLine(line);
    if (!d) {
      ptrs.set(x[0], x);
      results.push(x);
    } else {
      const dd = ptrs.get(x[0]);
      if (dd) {
        dd[2] = x[1];
      }
    }
  }
  return results;
};

function colorizeNode(n: tree.Node) {
  if (!n.hasValues || !n.dom) {
    return;
  }
  if (!n.value) {
    n.dom.style.backgroundColor = 'rgba(150,150,150,1)';
    return;
  }

  // rgb(239,179,179) - red
  // rgb(217,247,217) - green
  const r = (217 - 239) * n.value + 239;
  const g = (247 - 179) * n.value + 179;
  const b = (217 - 179) * n.value + 179;
  //const a = (0.15 + (0.15*n.value)).toFixed(2);
  const t = `rgba(${r},${g},${b},1)`;
  n.dom.style.backgroundColor = t;
}

function humanSizeCaption(n: tree.Node): string {
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
  if (n.value) {
    return `${n.id || ''} (${n.value.toFixed(2)}, ${numFmt})`;
  }
  if (n.hasValues && n.value === undefined) {
    return `${n.id || ''} (NONE, ${numFmt})`;
  }
  return `${n.id || ''} (${numFmt})`;
}

function formatText(rootNode: tree.Node): string {
  const lines: string[] = [];
  const help = (node: tree.Node, prefix: string) => {
    const path = prefix + (node.id ?? '');
    let size = node.value ?? node.size;
    lines.push(`${size}\t${path}`);
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
    .parse(process.argv);

  const args = program.opts();
  let processor = processSizeValuePathPairs;
  const arg0 = program.args[0];
  if (arg0 === 'du') {
    processor = processDir;
    program.args.shift();
  } else if (arg0 === 'du:json') {
    processor = processJsonSpaceUsage;
    program.args.shift();
  }

  const rows = await processor(program.args);
  const node = treeFromRows(rows);
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
