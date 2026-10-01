import { readFile } from "node:fs/promises";
import { parseAdvisorConfigs, AdvisorConfigError, type AdvisorConfig } from "../advisor/config.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface ModelRoute { role: string; model: string; thinking?: ThinkingLevel; extendedContext?: boolean }
export interface RouteSettings { readonly model: string; readonly thinking?: ThinkingLevel; readonly extendedContext?: boolean }
export interface RouteConfig {
  readonly routes: Readonly<Record<string, RouteSettings>>;
  readonly default?: RouteSettings;
  readonly advisors?: readonly AdvisorConfig[];
  /** Pi package sources (installed at user scope) whose extensions register model providers for orche's own runtime. */
  readonly providerExtensions?: readonly string[];
  /** Default for routes that do not say: use the curated maximum context window of models that have one (see src/pi/extended-context.ts). */
  readonly extendedContext?: boolean;
}
export class RouteConfigError extends Error {
  override readonly name = "RouteConfigError";
}
const thinkingLevels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MAX_PROVIDER_EXTENSIONS = 4;
function parseSettings(value: unknown, location: string): RouteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError(`${location}: expected route object`);
  const route = value as Record<string, unknown>;
  if (Object.keys(route).some(key => key !== "model" && key !== "thinking" && key !== "extendedContext")) throw new RouteConfigError(`${location}: unknown route field`);
  if (typeof route.model !== "string" || !/^[^\s/:]+\/[^\s:]+$/.test(route.model)) throw new RouteConfigError(`${location}.model: expected provider/modelId`);
  if (route.thinking !== undefined && (typeof route.thinking !== "string" || !thinkingLevels.includes(route.thinking)))
    throw new RouteConfigError(`${location}.thinking: expected ${thinkingLevels.join(", ")}`);
  if (route.extendedContext !== undefined && typeof route.extendedContext !== "boolean") throw new RouteConfigError(`${location}.extendedContext: expected boolean`);
  return {
    model: route.model,
    ...(route.thinking !== undefined ? { thinking: route.thinking as ThinkingLevel } : {}),
    ...(route.extendedContext !== undefined ? { extendedContext: route.extendedContext } : {}),
  };
}
export function parseRouteConfig(value: unknown): RouteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config: expected object");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => key !== "routes" && key !== "default" && key !== "advisors" && key !== "providerExtensions" && key !== "extendedContext")) throw new RouteConfigError("config: unknown field");
  if (config.extendedContext !== undefined && typeof config.extendedContext !== "boolean") throw new RouteConfigError("config.extendedContext: expected boolean");
  if (!config.routes || typeof config.routes !== "object" || Array.isArray(config.routes)) throw new RouteConfigError("config.routes: expected object");
  const routes: Record<string, RouteSettings> = Object.create(null) as Record<string, RouteSettings>;
  for (const [role, settings] of Object.entries(config.routes)) {
    if (!role.trim() || role !== role.trim()) throw new RouteConfigError("config.routes: role must be nonempty without surrounding whitespace");
    routes[role] = parseSettings(settings, `config.routes.${role}`);
  }
  let advisors: AdvisorConfig[] | undefined;
  if (config.advisors !== undefined) {
    try { advisors = parseAdvisorConfigs(config.advisors); }
    catch (error) { throw error instanceof AdvisorConfigError ? new RouteConfigError(error.message) : error; }
  }
  let providerExtensions: string[] | undefined;
  if (config.providerExtensions !== undefined) {
    const list = config.providerExtensions;
    if (!Array.isArray(list) || !list.length || list.length > MAX_PROVIDER_EXTENSIONS) throw new RouteConfigError(`config.providerExtensions: expected 1-${MAX_PROVIDER_EXTENSIONS} package sources`);
    providerExtensions = list.map((source, index) => {
      if (typeof source !== "string" || !source.trim() || source !== source.trim()) throw new RouteConfigError(`config.providerExtensions[${index}]: expected a non-empty Pi package source such as "npm:@scope/package"`);
      return source;
    });
    if (new Set(providerExtensions).size !== providerExtensions.length) throw new RouteConfigError("config.providerExtensions: duplicate source");
  }
  return {
    routes,
    ...(config.default !== undefined ? { default: parseSettings(config.default, "config.default") } : {}),
    ...(advisors ? { advisors } : {}),
    ...(providerExtensions ? { providerExtensions } : {}),
    ...(config.extendedContext !== undefined ? { extendedContext: config.extendedContext } : {}),
  };
}
export async function loadRouteConfig(path: string): Promise<RouteConfig> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new RouteConfigError(`Cannot load route config ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseRouteConfig(value);
}
export function resolveRoute(config: RouteConfig, role: string): ModelRoute {
  const route = (Object.hasOwn(config.routes, role) ? config.routes[role] : undefined) ?? config.default;
  if (!route) throw new RouteConfigError(`No route for role ${role} and no default route`);
  const extendedContext = route.extendedContext ?? config.extendedContext;
  return { role, ...route, ...(extendedContext !== undefined ? { extendedContext } : {}) };
}
export function parseRouteOverride(override: string): ModelRoute {
  const equals = override.indexOf("=");
  if (equals <= 0 || equals !== override.lastIndexOf("=")) throw new RouteConfigError("Override must be role=provider/modelId[:thinking]");
  const role = override.slice(0, equals);
  if (!role.trim() || role !== role.trim() || /\s/.test(role)) throw new RouteConfigError("Override role must be nonempty without whitespace");
  const reference = override.slice(equals + 1);
  const colon = reference.indexOf(":");
  const settings = colon < 0 ? { model: reference } : { model: reference.slice(0, colon), thinking: reference.slice(colon + 1) };
  return { role, ...parseSettings(settings, `override.${role}`) };
}
export function applyRouteOverrides(config: RouteConfig, overrides: readonly string[]): RouteConfig {
  const routes: Record<string, RouteSettings> = Object.assign(Object.create(null), config.routes) as Record<string, RouteSettings>;
  for (const override of overrides) {
    const { role, ...settings } = parseRouteOverride(override);
    routes[role] = settings;
  }
  return { ...config, routes };
}
