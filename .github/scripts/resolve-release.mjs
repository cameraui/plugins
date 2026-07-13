import { appendFileSync } from 'node:fs';

import { GO, NODE, PYTHON } from './plugins.mjs';

const tag = process.env.GITHUB_REF_NAME || process.argv[2] || '';

const match = tag.match(
  /^(camera-ui-.+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
);
if (!match) {
  console.error(
    `::error::Tag '${tag}' is not of the form camera-ui-<plugin>-v<version> (e.g. camera-ui-homekit-v0.0.50)`,
  );
  process.exit(1);
}

const [, plugin, version] = match;

const isNode = Object.prototype.hasOwnProperty.call(NODE, plugin);
const isPython = PYTHON.includes(plugin);
const isGo = Object.prototype.hasOwnProperty.call(GO, plugin);
if (!isNode && !isPython && !isGo) {
  console.error(
    `::error::Unknown plugin '${plugin}'. Add it to .github/scripts/plugins.mjs.`,
  );
  process.exit(1);
}

const runtime = isPython ? 'python' : isGo ? 'go' : 'node';
const externals = isNode ? NODE[plugin] : isGo ? GO[plugin] : '';

// dist-tag derives from the semver prerelease label. cui publish only knows
// --alpha / --beta / --latest, so anything else is rejected up front.
const prerelease = version.includes('-')
  ? version.split('-')[1].split('.')[0]
  : '';
let distTag;
if (prerelease === '') {
  distTag = 'latest';
} else if (prerelease === 'alpha' || prerelease === 'beta') {
  distTag = prerelease;
} else {
  console.error(
    `::error::Unsupported prerelease label '${prerelease}' in ${version}. Use -alpha.N or -beta.N.`,
  );
  process.exit(1);
}

const out = `plugin=${plugin}\nversion=${version}\nruntime=${runtime}\nexternals=${externals}\ndist_tag=${distTag}\n`;
console.log(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
