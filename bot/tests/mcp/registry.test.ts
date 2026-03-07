import { describe, expect, it } from 'vitest';
import { buildAllowedTools, buildMcpConfig } from '../../src/mcp/registry';
import { ALL_SERVERS } from '../../src/mcp/servers/index';
import type { MessageContext } from '../../src/types';

function makeContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    groupId: 'test-group',
    sender: '+61400000000',
    dbPath: '/tmp/test.db',
    timezone: 'Australia/Sydney',
    githubRepo: 'owner/repo',
    sourceRoot: '/tmp/src',
    signalCliUrl: 'http://localhost:8080',
    botPhoneNumber: '+61400000000',
    attachmentsDir: '/app/signal-attachments',
    whisperModelPath: '/models/ggml-large.bin',
    darkFactoryEnabled: '',
    darkFactoryProjectRoot: '',
    ...overrides,
  };
}

describe('buildAllowedTools', () => {
  it('should include BASE_TOOLS', () => {
    const tools = buildAllowedTools();
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Agent');
  });

  it('should include tools from ALL_SERVERS', () => {
    const tools = buildAllowedTools();
    for (const server of ALL_SERVERS) {
      for (const tool of server.tools) {
        expect(tools).toContain(`mcp__${server.configKey}__${tool.name}`);
      }
    }
  });

  it('should include transcription tool', () => {
    const tools = buildAllowedTools();
    expect(tools).toContain('mcp__transcription__transcribe_audio');
  });

  it('should include playwright tools', () => {
    const tools = buildAllowedTools();
    expect(tools).toContain('mcp__playwright__browser_navigate');
    expect(tools).toContain('mcp__playwright__browser_navigate_back');
    expect(tools).toContain('mcp__playwright__browser_snapshot');
    expect(tools).toContain('mcp__playwright__browser_take_screenshot');
    expect(tools).toContain('mcp__playwright__browser_click');
    expect(tools).toContain('mcp__playwright__browser_type');
    expect(tools).toContain('mcp__playwright__browser_press_key');
    expect(tools).toContain('mcp__playwright__browser_wait_for');
    expect(tools).toContain('mcp__playwright__browser_close');
    expect(tools).toContain('mcp__playwright__browser_tabs');
    expect(tools).toContain('mcp__playwright__browser_evaluate');
  });

  it('should return a comma-separated string', () => {
    const tools = buildAllowedTools();
    const parts = tools.split(',');
    expect(parts.length).toBeGreaterThan(10);
    for (const part of parts) {
      expect(part.trim()).toBe(part);
      expect(part.length).toBeGreaterThan(0);
    }
  });
});

describe('buildMcpConfig', () => {
  it('should create entry for each server in ALL_SERVERS', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    for (const server of ALL_SERVERS) {
      expect(config.mcpServers[server.configKey]).toBeDefined();
    }
  });

  it('should include command and args for each server', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    for (const server of ALL_SERVERS) {
      const entry = config.mcpServers[server.configKey] as { command: string; args: string[] };
      expect(['node', 'npx']).toContain(entry.command);
      expect(Array.isArray(entry.args)).toBe(true);
    }
  });

  it('should map envMapping to context fields correctly for reminders', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    const reminders = config.mcpServers.reminders as { env: Record<string, string> };
    expect(reminders.env.DB_PATH).toBe('/tmp/test.db');
    expect(reminders.env.MCP_GROUP_ID).toBe('test-group');
    expect(reminders.env.MCP_SENDER).toBe('+61400000000');
    expect(reminders.env.TZ).toBe('Australia/Sydney');
  });

  it('should map envMapping to context fields correctly for github', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    const github = config.mcpServers.github as { env: Record<string, string> };
    expect(github.env.GITHUB_REPO).toBe('owner/repo');
    expect(github.env.MCP_SENDER).toBe('+61400000000');
  });

  it('should map envMapping to context fields correctly for signal', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    const signal = config.mcpServers.signal as { env: Record<string, string> };
    expect(signal.env.SIGNAL_CLI_URL).toBe('http://localhost:8080');
    expect(signal.env.SIGNAL_ACCOUNT).toBe('+61400000000');
    expect(signal.env.MCP_GROUP_ID).toBe('test-group');
  });

  it('should include transcription server', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    const transcription = config.mcpServers.transcription as { env: Record<string, string> };
    expect(transcription).toBeDefined();
    expect(transcription.env.WHISPER_MODEL_PATH).toBe('/models/ggml-large.bin');
    expect(transcription.env.ATTACHMENTS_DIR).toBe('/app/signal-attachments');
  });

  it('should include playwright server', () => {
    const context = makeContext();
    const config = buildMcpConfig(context);
    const playwright = config.mcpServers.playwright as { command: string; args: string[] };
    expect(playwright).toBeDefined();
    expect(playwright.command).toBe('npx');
    expect(playwright.args).toContain('--headless');
  });

  it('should handle missing optional context fields gracefully', () => {
    const context = makeContext({ attachmentsDir: '', whisperModelPath: '' });
    const config = buildMcpConfig(context);
    const transcription = config.mcpServers.transcription as { env: Record<string, string> };
    expect(transcription.env.WHISPER_MODEL_PATH).toBe('');
    expect(transcription.env.ATTACHMENTS_DIR).toBe('');
  });
});
