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
    ],
    resolve() {
      return { command: 'npx', args: ['@playwright/mcp', '--headless'] };
    },
  },
};

const BASE_TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep,Agent';

export function buildAllowedTools(): string {
  const mcpTools = ALL_SERVERS.flatMap(s => s.tools.map(t => `mcp__${s.configKey}__${t.name}`));
  const externalTools = Object.values(EXTERNAL_SERVERS).flatMap(s => s.tools);
  return [BASE_TOOLS, ...mcpTools, ...externalTools].join(',');
}

export function buildMcpConfig(context: MessageContext): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};

  for (const server of ALL_SERVERS) {
    const resolved = resolveMcpServerPath(`servers/${server.entrypoint}`);
    const env: Record<string, string> = {};
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
