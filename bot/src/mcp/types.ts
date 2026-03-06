import type { MessageContext } from '../types';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** Maps env var names to MessageContext field names */
export type EnvMapping = Record<string, keyof MessageContext>;

export interface McpServerDefinition {
  serverName: string;
  configKey: string;
  entrypoint: string;
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  envMapping: EnvMapping;
  onInit?: () => void;
  onClose?: () => void;
}
