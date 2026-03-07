import type { MessageContext } from '../types';

export type ToolResultContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ToolResultContent[];
  isError?: boolean;
};

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** Maps env var names to MessageContext (AppConfig & RequestContext) field names */
export type EnvMapping = Record<string, keyof MessageContext>;

export interface McpServerDefinition {
  serverName: string;
  configKey: string;
  /** Filename only, e.g. 'memories' — registry resolves to servers/{entrypoint}.ts */
  entrypoint: string;
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  envMapping: EnvMapping;
  onInit?: () => void;
  onClose?: () => void;
}
