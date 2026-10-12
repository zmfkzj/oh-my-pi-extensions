// @amaster.ai/pi-computer-use with its tools loaded on demand (see ./on-demand.js and the root README).
// Loaded by Pi's extension loader, which provides `typebox` and `@earendil-works/pi-ai` as it does for the package.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import upstream, { loadConfigFromFile, resolveConfig } from "../../node_modules/@amaster.ai/pi-computer-use/dist/index.js";
import { CORE_TOOLS, TOOL_GROUPS } from "../../node_modules/@amaster.ai/pi-computer-use/dist/tool-groups.js";
import { createComputerUseOnDemand } from "./on-demand.js";

export default createComputerUseOnDemand({
  upstream,
  coreTools: CORE_TOOLS,
  groups: TOOL_GROUPS,
  loadConfig: (ctx) => resolveConfig(loadConfigFromFile({ cwd: ctx.cwd, projectTrusted: ctx?.isProjectTrusted?.() === true })),
  loaderParameters: (groups) => Type.Object({
    group: Type.Optional(StringEnum(groups, { description: "Tool group to load (\"core\" first). Omit to list groups and their status." })),
  }),
});
