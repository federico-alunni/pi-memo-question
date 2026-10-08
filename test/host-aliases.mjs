// Run native Node tests with the host packages Pi's extension loader provides.
// Host location, first match wins:
//   1. PI_HOST_DIR (directory of @earendil-works/pi-coding-agent) -> aliased
//   2. host packages installed in node_modules (CI: npm install --no-save) -> plain Node resolution
// Otherwise fail with an explicit message.
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

if (process.env.PI_HOST_DIR) {
	const dir = process.env.PI_HOST_DIR.replace(/\/?$/, "/");
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
} else if (!installedLocally()) {
	throw new Error(
		`Host packages not found. Either run: npm install --no-save ${HOST_PKG} @earendil-works/pi-tui typebox\n` +
			`or set PI_HOST_DIR to the directory of ${HOST_PKG} (e.g. $(npm root -g)/${HOST_PKG}).`,
	);
}
