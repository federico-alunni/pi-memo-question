// Run native Node tests with the host packages Pi's extension loader provides.
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const host = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/";
const require = createRequire(`${host}package.json`);
const aliases = {
  "@earendil-works/pi-coding-agent": `${host}dist/index.js`,
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  typebox: require.resolve("typebox"),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(aliases[specifier] ? pathToFileURL(aliases[specifier]).href : specifier, context);
  },
});
