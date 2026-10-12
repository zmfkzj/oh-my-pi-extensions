// On-demand loading for @amaster.ai/pi-computer-use (the user's physical screen), without changing the package.
//
// Upstream registers every driver tool and activates its core set (14 tools, the largest declarations of a main
// session) at session start; its other groups are already inactive until `computer_use_tools` loads them. This wrapper
// runs upstream's extension unchanged through a proxy of Pi's ExtensionAPI that only changes how its tools start:
// driver tools are registered with Pi's `defaultActive: false` (still `direct`: declared and callable only once active,
// as upstream's inactive groups), and `computer_use_tools` gains a "core" group that loads the core set. Execution,
// approvals, driver lifecycle and the other groups stay upstream's. `toolProfile: "full"` or `loadOnDemand: false` in
// the "pi-computer-use" settings section restores upstream's start-up behaviour.

export const PREFIX = "computer_use_";
export const LOADER = `${PREFIX}tools`;
export const CONNECT = `${PREFIX}connect`;
export const LOADER_COMMAND = "computer-use-tools";
export const CONNECT_COMMAND = "computer-use-connect";
export const CORE_GROUP = "core";

/** On-demand applies to upstream's default core profile unless the user opts out. */
export function loadsOnDemand(config) {
  return (config?.toolProfile ?? "core") === "core" && config?.loadOnDemand !== false;
}

/**
 * @param {object} options
 * @param {(pi: object) => void} options.upstream upstream's extension factory
 * @param {readonly string[]} options.coreTools upstream's core tool names, unprefixed
 * @param {Record<string, { summary: string, tools: readonly string[] }>} options.groups upstream's other groups
 * @param {(ctx: object) => object} options.loadConfig upstream's resolved settings for a session
 * @param {(groups: string[]) => object} options.loaderParameters the loader's parameter schema for these group names
 */
export function createComputerUseOnDemand({ upstream, coreTools, groups, loadConfig, loaderParameters }) {
  const core = coreTools.map(name => `${PREFIX}${name}`);
  const groupNames = [CORE_GROUP, ...Object.keys(groups)];
  const groupSummary = Object.entries(groups).map(([name, group]) => `${name} (${group.summary})`).join(", ");
  const coreSummary = "apps, window state, click, type, keys, scroll";

  return function computerUseOnDemand(pi) {
    let onDemand = true;
    let upstreamLoader;
    let registeredLoader; // "on-demand" | "upstream"

    const registered = () => new Set(pi.getAllTools().map(tool => tool.name));
    const loadCore = () => {
      const all = registered();
      const wanted = core.filter(name => all.has(name));
      const active = pi.getActiveTools();
      const added = wanted.filter(name => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...active, ...added]);
      return { wanted, added };
    };
    const coreStatus = () => {
      const all = registered();
      const active = new Set(pi.getActiveTools());
      const present = core.filter(name => all.has(name));
      const count = present.filter(name => active.has(name)).length;
      const state = present.length === 0 ? "unavailable until the driver is registered"
        : count === 0 ? "not loaded" : count === present.length ? "loaded" : `${count}/${present.length} loaded`;
      return `- ${CORE_GROUP} (${core.length} tools, ${state}): everyday tools: ${coreSummary}`;
    };
    const coreResultText = () => {
      const { wanted, added } = loadCore();
      if (wanted.length === 0) return undefined;
      return `${added.length === 0 ? "Already loaded" : "Loaded"} the core computer-use tools (${wanted.length}): ${wanted.join(", ")}. They are available from the next turn.`;
    };
    const withCoreLine = (text) => text.replace(/^(Computer-use tool groups:)/, `$1\n${coreStatus()}`);

    const loaderTool = (def) => ({
      ...def,
      description: `Load computer-use tools for the user's physical screen; they are not declared until loaded. Groups: ${CORE_GROUP} (${coreSummary}), ${groupSummary}. Call without arguments to list groups and their status.`,
      parameters: loaderParameters(groupNames),
      promptSnippet: "Load computer-use tools for the user's own screen when the user asks you to act on it",
      promptGuidelines: [
        `computer_use_* tools act on the user's physical screen and are loaded on demand. When the user asks you to operate their own screen or apps, call ${LOADER} with group "${CORE_GROUP}" first; load another group only when the task needs it. Loaded tools are available from the next turn and stay loaded for the session.`,
      ],
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (params?.group === CORE_GROUP) {
          const text = coreResultText();
          return text
            ? { content: [{ type: "text", text }], details: undefined }
            : { content: [{ type: "text", text: `Driver tools are not registered yet — connect the driver first with ${CONNECT}, then load the "${CORE_GROUP}" group again.` }], details: undefined, isError: true };
        }
        const result = await def.execute(toolCallId, params, signal, onUpdate, ctx);
        if (params?.group !== undefined) return result;
        return { ...result, content: result.content.map(block => block.type === "text" ? { ...block, text: withCoreLine(block.text) } : block) };
      },
    });
    const connectTool = (def) => ({
      ...def,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const result = await def.execute(toolCallId, params, signal, onUpdate, ctx);
        if (!onDemand || result?.isError) return result;
        const text = coreResultText();
        if (!text) return result;
        return { ...result, content: [...result.content, { type: "text", text: `${text} Load other groups with ${LOADER}.` }] };
      },
    });
    const syncLoader = () => {
      const mode = onDemand ? "on-demand" : "upstream";
      if (!upstreamLoader || registeredLoader === mode) return;
      registeredLoader = mode;
      pi.registerTool(onDemand ? loaderTool(upstreamLoader) : upstreamLoader);
    };

    const registerTool = (def) => {
      if (def?.name === LOADER) {
        upstreamLoader = def;
        registeredLoader = undefined;
        return syncLoader();
      }
      if (def?.name === CONNECT) return pi.registerTool(onDemand ? connectTool(def) : def);
      const optional = onDemand && typeof def?.name === "string" && def.name.startsWith(PREFIX)
        && (def.exposure ?? "direct") === "direct" && def.defaultActive === undefined;
      return pi.registerTool(optional ? { ...def, defaultActive: false } : def);
    };
    // Upstream deactivates only to apply its core profile at session start; with on-demand loading nothing it
    // registers starts active, so a tool loaded earlier in the session (before /reload or a driver reconnect) stays.
    const setActiveTools = (names) => {
      if (!onDemand) return pi.setActiveTools(names);
      const loaded = pi.getActiveTools().filter(name => name.startsWith(PREFIX) && !names.includes(name));
      return pi.setActiveTools([...names, ...loaded]);
    };
    const notifyingWithCore = (ctx) => new Proxy(ctx, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "ui" || !value) return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value, {
          get(ui, name) {
            const member = Reflect.get(ui, name, ui);
            if (name === "notify") return (message, level) => member.call(ui, typeof message === "string" ? withCoreLine(message) : message, level);
            return typeof member === "function" ? member.bind(ui) : member;
          },
        });
      },
    });
    const registerCommand = (name, options) => {
      if (name === LOADER_COMMAND) {
        return pi.registerCommand(name, {
          ...options,
          getArgumentCompletions: (prefix) => {
            const rest = options.getArgumentCompletions?.(prefix) ?? [];
            if (!onDemand || !CORE_GROUP.startsWith(prefix.trim().toLowerCase())) return rest;
            return [{ value: CORE_GROUP, label: CORE_GROUP, description: `Everyday tools: ${coreSummary}` }, ...rest];
          },
          async handler(args, ctx) {
            if (!onDemand) return options.handler(args, ctx);
            const group = String(args ?? "").trim().toLowerCase();
            if (group !== CORE_GROUP) return options.handler(args, group ? ctx : notifyingWithCore(ctx));
            const text = coreResultText();
            ctx.ui.notify(text ? `pi-computer-use: ${text}` : `pi-computer-use: the core tools are not registered (driver not connected? try /${CONNECT_COMMAND}).`, "info");
          },
        });
      }
      if (name === CONNECT_COMMAND) {
        return pi.registerCommand(name, {
          ...options,
          async handler(args, ctx) {
            await options.handler(args, ctx);
            if (onDemand) loadCore();
          },
        });
      }
      return pi.registerCommand(name, options);
    };

    const api = new Proxy(pi, {
      get(target, prop) {
        if (prop === "registerTool") return registerTool;
        if (prop === "registerCommand") return registerCommand;
        if (prop === "setActiveTools") return setActiveTools;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Before upstream's own session_start handler, which registers the driver tools: Pi runs them in this order.
    pi.on("session_start", async (_event, ctx) => {
      try { onDemand = loadsOnDemand(loadConfig(ctx)); } catch { onDemand = true; }
      syncLoader();
    });
    upstream(api);
  };
}
