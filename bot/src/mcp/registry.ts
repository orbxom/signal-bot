import fs from 'node:fs';
import path from 'node:path';
import type { MessageContext } from '../types';
import { ALL_SERVERS } from './servers/index';

// Resolve MCP server path for dev (tsx) vs production (compiled JS)
const mcpPathCache = new Map<string, { command: string; args: string[] }>();

export function resolveMcpServerPath(name: string): { command: string; args: string[] } {
  const cached = mcpPathCache.get(name);
  if (cached) return cached;
  const jsPath = path.resolve(__dirname, `${name}.js`);
  const tsPath = path.resolve(__dirname, `${name}.ts`);
  const useTs = !fs.existsSync(jsPath) && fs.existsSync(tsPath);
  const result = {
    command: useTs ? 'npx' : 'node',
    args: useTs ? ['tsx', tsPath] : [jsPath],
  };
  mcpPathCache.set(name, result);
  return result;
}

// Resolve transcription binary (compiled Rust, not TS)
function resolveTranscriptionBinary(): { command: string; args: string[] } {
  const binPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'transcription',
    'target',
    'release',
    'signal-bot-transcription',
  );
  if (fs.existsSync(binPath)) {
    return { command: binPath, args: [] };
  }
  // Dev fallback: cargo run
  const cargoPath = path.resolve(__dirname, '..', '..', '..', 'transcription');
  return { command: 'cargo', args: ['run', '--release', '--manifest-path', `${cargoPath}/Cargo.toml`] };
}

// External servers that aren't part of our registry (they use different commands)
const EXTERNAL_SERVERS = {
  transcription: {
    tools: ['mcp__transcription__transcribe_audio'],
    resolve(context: MessageContext) {
      const bin = resolveTranscriptionBinary();
      return {
        command: bin.command,
        args: bin.args,
        env: {
          WHISPER_MODEL_PATH: context.whisperModelPath || '',
          ATTACHMENTS_DIR: context.attachmentsDir || '',
        },
      };
    },
  },
  playwright: {
    tools: [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_navigate_back',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_take_screenshot',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_press_key',
      'mcp__playwright__browser_wait_for',
      'mcp__playwright__browser_close',
      'mcp__playwright__browser_tabs',
      'mcp__playwright__browser_evaluate',
      'mcp__playwright__browser_resize',
      'mcp__playwright__browser_console_messages',
      'mcp__playwright__browser_handle_dialog',
      'mcp__playwright__browser_file_upload',
      'mcp__playwright__browser_fill_form',
      'mcp__playwright__browser_install',
      'mcp__playwright__browser_network_requests',
      'mcp__playwright__browser_run_code',
      'mcp__playwright__browser_drag',
      'mcp__playwright__browser_hover',
      'mcp__playwright__browser_select_option',
    ],
    resolve() {
      return { command: 'npx', args: ['@playwright/mcp', '--headless', '--browser', 'chromium'] };
    },
  },
};

const BASE_TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep,Agent';

export function buildAllowedTools(): string {
  const mcpTools = ALL_SERVERS.flatMap(s => s.tools.map(t => `mcp__${s.configKey}__${t.name}`));
  const externalTools = Object.values(EXTERNAL_SERVERS).flatMap(s => s.tools);
  return [BASE_TOOLS, ...mcpTools, ...externalTools].join(',');
}

export interface BuildMcpConfigOptions {
  toolNotificationsEnabled?: boolean;
}

export function buildMcpConfig(
  context: MessageContext,
  options?: BuildMcpConfigOptions,
): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};

  // Common env vars injected into every MCP server
  const commonEnv: Record<string, string> = {
    TOOL_NOTIFICATIONS_ENABLED: options?.toolNotificationsEnabled ? '1' : '0',
    SIGNAL_CLI_URL: context.signalCliUrl || '',
    SIGNAL_ACCOUNT: context.botPhoneNumber || '',
  };

  for (const server of ALL_SERVERS) {
    const resolved = resolveMcpServerPath(`servers/${server.entrypoint}`);
    const env: Record<string, string> = { ...commonEnv };
    for (const [envKey, contextField] of Object.entries(server.envMapping)) {
      const value = context[contextField];
      if (value !== undefined) env[envKey] = String(value);
    }
    mcpServers[server.configKey] = {
      command: resolved.command,
      args: resolved.args,
      env,
    };
  }

  // Add external servers
  const transcription = EXTERNAL_SERVERS.transcription.resolve(context);
  mcpServers.transcription = transcription;
  mcpServers.playwright = EXTERNAL_SERVERS.playwright.resolve();

  return { mcpServers };
}
