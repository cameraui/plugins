import { appendFileSync } from 'node:fs';

import { NODE, PYTHON } from './plugins.mjs';

const changed = JSON.parse(process.env.CHANGED || '[]');
const allNode = changed.includes('shared-node');
const allPython = changed.includes('shared-python');

const node = Object.entries(NODE)
  .filter(([plugin]) => allNode || changed.includes(plugin))
  .map(([plugin, externals]) => ({ plugin, externals }));

const python = PYTHON.filter((plugin) => allPython || changed.includes(plugin));

const out = `node=${JSON.stringify(node)}\npython=${JSON.stringify(python)}\n`;
console.log(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
