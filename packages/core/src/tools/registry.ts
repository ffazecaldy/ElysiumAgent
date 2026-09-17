import type { ToolDefinition } from "../types/provider";
import type { PathPolicy, Tool } from "../types/tools";
import { createBashTool } from "./builtins/bash";
import { createEditTool } from "./builtins/edit";
import { createReadTool } from "./builtins/read";
import { type WebToolOptions, createWebFetchTool } from "./builtins/web-fetch";
import { createWebSearchTool } from "./builtins/web-search";
import { createWriteTool } from "./builtins/write";

/** Registry of tools keyed by unique name; produces provider-facing definitions. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  toDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

export interface BuiltinToolsOptions {
  /**
   * Network gate for the web builtins (web_fetch / web_search). Default true;
   * when false both tools still register but every execute() returns an
   * isError "network disabled for this run" result without any fetch.
   */
  network?: boolean;
}

export function createBuiltinTools(policy: PathPolicy, options: BuiltinToolsOptions = {}): Tool[] {
  const webOptions: WebToolOptions = { network: options.network ?? true };
  return [
    createReadTool(policy),
    createWriteTool(policy),
    createEditTool(policy),
    createBashTool(policy),
    createWebFetchTool(webOptions),
    createWebSearchTool(webOptions),
  ];
}
