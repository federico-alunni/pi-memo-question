// Run native Node tests with the host packages Pi's extension loader provides.
// Host location, first match wins:
//   1. PI_HOST_DIR (directory of @earendil-works/pi-coding-agent) -> aliased
//   2. host packages installed next to the repo (CI: npm install --no-save) -> plain Node resolution
//   3. Homebrew global install (macOS) -> aliased
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const HOST_PKG = "@earendil-works/pi-coding-agent";

function installedLocally() {
	try {
		import.meta.resolve(HOST_PKG);
		import.meta.resolve("@earendil-works/pi-tui");
		import.meta.resolve("typebox");
		return true;
	} catch {
		return false;
	}
}

if (process.env.PI_HOST_DIR || !installedLocally()) {
	const dir = (process.env.PI_HOST_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent").replace(/\/?$/, "/");
	const require = createRequire(`${dir}package.json`);
	const aliases = {
		[HOST_PKG]: `${dir}dist/index.js`,
		"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
		typebox: require.resolve("typebox"),
	};
	registerHooks({
		resolve(specifier, context, nextResolve) {
			return nextResolve(aliases[specifier] ? pathToFileURL(aliases[specifier]).href : specifier, context);
		},
	});
}
