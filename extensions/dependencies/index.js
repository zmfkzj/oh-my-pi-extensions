// The umbrella's dependency commands: `/oh-my-pi doctor|install-deps` over every bundled package (./umbrella.js) and
// `/computer-use doctor|install-deps` for the npm-installed physical-desktop package (./computer-use.js). Uses only
// Node builtins, so it loads even when a package's dependencies are missing.
import { fileURLToPath } from "node:url";
import { registerDependencyProvider } from "./contract.js";
import { createComputerUseProvider, registerComputerUseCommand } from "./computer-use.js";
import { registerUmbrellaCommand } from "./umbrella.js";

/** @param {{ root?: string, computerUse?: Parameters<typeof createComputerUseProvider>[0], timeouts?: { check?: number, install?: number }, installNpm?: any }} [options] */
export function createDependencyExtension(options = {}) {
  const root = options.root ?? fileURLToPath(new URL("../../", import.meta.url));
  return function dependencyExtension(pi) {
    const computerUse = createComputerUseProvider({ root, ...options.computerUse });
    registerDependencyProvider(pi.events, computerUse);
    registerComputerUseCommand(pi, computerUse);
    registerUmbrellaCommand(pi, { root, timeouts: options.timeouts, installNpm: options.installNpm });
  };
}

export default createDependencyExtension();
