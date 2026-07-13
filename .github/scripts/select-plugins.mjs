import { appendFileSync } from 'node:fs';

import { GO, NODE, PYTHON } from './plugins.mjs';

const changed = JSON.parse(process.env.CHANGED || '[]');
const allNode = changed.includes('shared-node');
const allPython = changed.includes('shared-python');
const allGo = changed.includes('shared-go');

const node = Object.entries(NODE)
  .filter(([plugin]) => allNode || changed.includes(plugin))
  .map(([plugin, externals]) => ({ plugin, externals }));

const python = PYTHON.filter((plugin) => allPython || changed.includes(plugin));

const go = Object.entries(GO)
  .filter(([plugin]) => allGo || changed.includes(plugin))
  .map(([plugin, externals]) => ({ plugin, externals }));

const out = `node=${JSON.stringify(node)}\npython=${JSON.stringify(python)}\ngo=${JSON.stringify(go)}\n`;
console.log(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
