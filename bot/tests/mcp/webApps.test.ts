import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resultText } from '../../src/mcp/result';
import { webAppsServer } from '../../src/mcp/servers/webApps';

describe('webApps MCP server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `signal-bot-webapp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
    process.env.DB_PATH = dbPath;
    process.env.MCP_GROUP_ID = 'test-group';
    process.env.MCP_SENDER = 'test-sender';
    process.env.WEB_APPS_DIR = join(testDir, 'sites');
    delete process.env.SWA_DEPLOYMENT_TOKEN;
    webAppsServer.onInit?.();
  });

  afterEach(() => {
    webAppsServer.onClose?.();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('tool listing', () => {
    it('should have 9 tools', () => {
      expect(webAppsServer.tools).toHaveLength(9);
      const names = webAppsServer.tools.map(t => t.name);
      expect(names).toContain('write_web_app');
      expect(names).toContain('read_web_app');
      expect(names).toContain('edit_web_app');
      expect(names).toContain('create_web_app');
      expect(names).toContain('list_sites');
      expect(names).toContain('delete_site');
      expect(names).toContain('preview_web_app');
      expect(names).toContain('stop_preview');
      expect(names).toContain('deploy_web_apps');
    });
  });

  describe('write_web_app', () => {
    it('should write an index.html file for a site', async () => {
      const result = await webAppsServer.handlers.write_web_app({
        site_name: 'my-site',
        content: '<h1>Hello</h1>',
      });
      expect(result.isError).toBeFalsy();
      const text = resultText(result);
      expect(text).toContain('my-site');

      const filePath = join(testDir, 'sites', 'my-site', 'index.html');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe('<h1>Hello</h1>');
    });

    it('should write a custom filename', async () => {
      const result = await webAppsServer.handlers.write_web_app({
        site_name: 'my-site',
        filename: 'styles.css',
        content: 'body { color: red; }',
      });
      expect(result.isError).toBeFalsy();

      const filePath = join(testDir, 'sites', 'my-site', 'styles.css');
      expect(readFileSync(filePath, 'utf-8')).toBe('body { color: red; }');
    });

    it('should overwrite existing files (edit flow)', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'my-site',
        content: '<h1>V1</h1>',
      });
      await webAppsServer.handlers.write_web_app({
        site_name: 'my-site',
        content: '<h1>V2</h1>',
      });

      const filePath = join(testDir, 'sites', 'my-site', 'index.html');
      expect(readFileSync(filePath, 'utf-8')).toBe('<h1>V2</h1>');
    });

    it('should reject invalid site names', async () => {
      const result = await webAppsServer.handlers.write_web_app({
        site_name: '../escape',
        content: '<h1>Bad</h1>',
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Invalid site_name');
    });

    it('should reject site names with spaces', async () => {
      const result = await webAppsServer.handlers.write_web_app({
        site_name: 'my site',
        content: '<h1>Bad</h1>',
      });
      expect(result.isError).toBe(true);
    });

    it('should reject content exceeding 1MB', async () => {
      const result = await webAppsServer.handlers.write_web_app({
        site_name: 'big',
        content: 'x'.repeat(1024 * 1024 + 1),
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('exceeds');
    });

    it('should require site_name parameter', async () => {
      const result = await webAppsServer.handlers.write_web_app({ content: '<h1>Hi</h1>' });
      expect(result.isError).toBe(true);
    });

    it('should require content parameter', async () => {
      const result = await webAppsServer.handlers.write_web_app({ site_name: 'test' });
      expect(result.isError).toBe(true);
    });
  });

  describe('read_web_app', () => {
    it('should read back a written file', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'reader-test',
        content: '<h1>Read me</h1>',
      });

      const result = await webAppsServer.handlers.read_web_app({
        site_name: 'reader-test',
      });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain('<h1>Read me</h1>');
    });

    it('should read a specific filename', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'reader-test',
        filename: 'app.js',
        content: 'console.log("hi")',
      });

      const result = await webAppsServer.handlers.read_web_app({
        site_name: 'reader-test',
        filename: 'app.js',
      });
      expect(resultText(result)).toContain('console.log("hi")');
    });

    it('should error for non-existent site', async () => {
      const result = await webAppsServer.handlers.read_web_app({ site_name: 'nope' });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('not found');
    });

    it('should error for non-existent file', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'exists',
        content: '<h1>Hi</h1>',
      });
      const result = await webAppsServer.handlers.read_web_app({
        site_name: 'exists',
        filename: 'nope.js',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('edit_web_app', () => {
    it('should replace text in a file', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-test',
        content: '<h1>Hello World</h1>\n<p>Some content here</p>',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-test',
        old_text: 'Hello World',
        new_text: 'Updated Title',
      });
      expect(result.isError).toBeFalsy();
      const text = resultText(result);
      expect(text).toContain('Updated Title');

      const filePath = join(testDir, 'sites', 'edit-test', 'index.html');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toBe('<h1>Updated Title</h1>\n<p>Some content here</p>');
    });

    it('should edit a specific filename', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-test',
        filename: 'styles.css',
        content: 'body { color: red; }',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-test',
        filename: 'styles.css',
        old_text: 'red',
        new_text: 'blue',
      });
      expect(result.isError).toBeFalsy();

      const filePath = join(testDir, 'sites', 'edit-test', 'styles.css');
      expect(readFileSync(filePath, 'utf-8')).toBe('body { color: blue; }');
    });

    it('should default filename to index.html', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-default',
        content: '<p>original</p>',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-default',
        old_text: 'original',
        new_text: 'modified',
      });
      expect(result.isError).toBeFalsy();

      const filePath = join(testDir, 'sites', 'edit-default', 'index.html');
      expect(readFileSync(filePath, 'utf-8')).toBe('<p>modified</p>');
    });

    it('should error when old_text is not found', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-notfound',
        content: '<h1>Hello</h1>',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-notfound',
        old_text: 'Goodbye',
        new_text: 'Hi',
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('not found');
    });

    it('should error when old_text matches multiple times', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-ambiguous',
        content: '<p>hello</p>\n<p>hello</p>\n<p>hello</p>',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-ambiguous',
        old_text: 'hello',
        new_text: 'bye',
      });
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain('3 times');
    });

    it('should error when site does not exist', async () => {
      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'nonexistent',
        old_text: 'a',
        new_text: 'b',
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('not found');
    });

    it('should error when file does not exist', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'edit-nofile',
        content: '<h1>Hi</h1>',
      });

      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'edit-nofile',
        filename: 'missing.js',
        old_text: 'a',
        new_text: 'b',
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('not found');
    });

    it('should reject path traversal in filename', async () => {
      await webAppsServer.handlers.write_web_app({
        site_name: 'traversal-test',
        content: '<h1>Hi</h1>',
      });
      const result = await webAppsServer.handlers.edit_web_app({
        site_name: 'traversal-test',
        filename: '../etc/passwd',
        old_text: 'a',
        new_text: 'b',
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Path traversal');
    });
  });

  describe('list_sites', () => {
    it('should return empty when no sites', async () => {
      const result = await webAppsServer.handlers.list_sites({});
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain('No sites');
    });

    it('should list created sites', async () => {
      await webAppsServer.handlers.write_web_app({ site_name: 'alpha', content: '<h1>A</h1>' });
      await webAppsServer.handlers.write_web_app({ site_name: 'beta', content: '<h1>B</h1>' });

      const result = await webAppsServer.handlers.list_sites({});
      const text = resultText(result);
      expect(text).toContain('alpha');
      expect(text).toContain('beta');
    });
  });

  describe('delete_site', () => {
    it('should delete an existing site', async () => {
      await webAppsServer.handlers.write_web_app({ site_name: 'doomed', content: '<h1>Bye</h1>' });
      const result = await webAppsServer.handlers.delete_site({ site_name: 'doomed' });
      expect(result.isError).toBeFalsy();

      const siteDir = join(testDir, 'sites', 'doomed');
      expect(existsSync(siteDir)).toBe(false);
    });

    it('should error for non-existent site', async () => {
      const result = await webAppsServer.handlers.delete_site({ site_name: 'ghost' });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('not found');
    });
  });

  describe('preview_web_app', () => {
    it('should start a local server and return a URL', async () => {
      await webAppsServer.handlers.write_web_app({ site_name: 'preview-test', content: '<h1>Preview</h1>' });

      const result = await webAppsServer.handlers.preview_web_app({ site_name: 'preview-test' });
      expect(result.isError).toBeFalsy();
      const text = resultText(result);
      expect(text).toMatch(/http:\/\/localhost:\d+/);

      // Verify the server is actually serving
      const url = text.match(/http:\/\/localhost:\d+/)?.[0] as string;
      const response = await fetch(`${url}/index.html`);
      expect(response.ok).toBe(true);
      const body = await response.text();
      expect(body).toBe('<h1>Preview</h1>');

      await webAppsServer.handlers.stop_preview({});
    });

    it('should error for non-existent site', async () => {
      const result = await webAppsServer.handlers.preview_web_app({ site_name: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('stop_preview', () => {
    it('should stop a running preview', async () => {
      await webAppsServer.handlers.write_web_app({ site_name: 'stop-test', content: '<h1>Stop</h1>' });
      const previewResult = await webAppsServer.handlers.preview_web_app({ site_name: 'stop-test' });
      const url = resultText(previewResult).match(/http:\/\/localhost:\d+/)?.[0] as string;

      const stopResult = await webAppsServer.handlers.stop_preview({});
      expect(stopResult.isError).toBeFalsy();

      // Server should no longer be reachable
      await expect(fetch(`${url}/index.html`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    });

    it('should be a no-op when no preview is running', async () => {
      const result = await webAppsServer.handlers.stop_preview({});
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain('No preview');
    });
  });

  describe('deploy_web_apps', () => {
    it('should error when SWA_DEPLOYMENT_TOKEN is not set', async () => {
      await webAppsServer.handlers.write_web_app({ site_name: 'deploy-test', content: '<h1>Deploy</h1>' });
      const result = await webAppsServer.handlers.deploy_web_apps({});
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('SWA_DEPLOYMENT_TOKEN');
    });

    it('should error when no sites exist', async () => {
      process.env.SWA_DEPLOYMENT_TOKEN = 'fake-token';
      const result = await webAppsServer.handlers.deploy_web_apps({});
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('No sites');
    });
  });
});
