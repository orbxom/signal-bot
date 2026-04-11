import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseConnection } from '../../db';
import { WebAppStore } from '../../stores/webAppStore';
import { readStorageEnv } from '../env';
import { withNotification } from '../notify';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireString } from '../validate';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const PREVIEW_TIMEOUT_MS = 120_000; // 2 minutes
const SWA_DEPLOY_TIMEOUT = 120_000;
const DAILY_DEPLOY_LIMIT = 10;
const HOURLY_GROUP_DEPLOY_LIMIT = 3;
const VALID_SITE_NAME = /^[a-z0-9][a-z0-9-]*$/;

let conn: DatabaseConnection;
let store: WebAppStore;
let groupId: string;
let sitesDir: string;
let previewServer: http.Server | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function resolveSwaCliPath(): string {
  // Explicit override
  if (process.env.SWA_CLI_PATH) return process.env.SWA_CLI_PATH;

  // Check common global npm bin locations
  const candidates = [
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'swa'),
    '/usr/local/bin/swa',
    '/usr/bin/swa',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fallback to bare name (relies on PATH)
  return 'swa';
}

function validateSiteName(name: string): string | null {
  if (!VALID_SITE_NAME.test(name)) {
    return 'Invalid site_name. Use only lowercase letters, numbers, and hyphens. Must start with a letter or number.';
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return 'Invalid site_name. Path traversal not allowed.';
  }
  return null;
}

function getSiteDir(siteName: string): string {
  return path.join(sitesDir, siteName);
}

function stopPreviewServer(): void {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (previewServer) {
    previewServer.close();
    previewServer = null;
  }
}

const TOOLS = [
  {
    name: 'write_web_app',
    title: 'Write Web App File',
    description:
      'Write or update a file in a web app site. Creates the site if it does not exist. Use this to build single-file HTML/JS/CSS websites. Call multiple times to add multiple files to the same site.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site_name: {
          type: 'string',
          description: 'Site name (lowercase letters, numbers, hyphens). e.g. "timer", "todo-app"',
        },
        filename: {
          type: 'string',
          description: 'Filename to write. Defaults to "index.html".',
        },
        content: {
          type: 'string',
          description: 'The file content (HTML, CSS, JS, etc.)',
        },
      },
      required: ['site_name', 'content'],
    },
  },
  {
    name: 'read_web_app',
    title: 'Read Web App File',
    description:
      'Read the current content of a file in a web app site. Use this before editing to see the current state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site_name: {
          type: 'string',
          description: 'Site name to read from',
        },
        filename: {
          type: 'string',
          description: 'Filename to read. Defaults to "index.html".',
        },
      },
      required: ['site_name'],
    },
  },
  {
    name: 'edit_web_app',
    title: 'Edit Web App File',
    description:
      'Find and replace text in a web app file. The old_text must match exactly once in the file. Use this for surgical edits instead of rewriting entire files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site_name: {
          type: 'string',
          description: 'Site name to edit',
        },
        filename: {
          type: 'string',
          description: 'Filename to edit. Defaults to "index.html".',
        },
        old_text: {
          type: 'string',
          description: 'Exact text to find (must appear exactly once in the file)',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['site_name', 'old_text', 'new_text'],
    },
  },
  {
    name: 'list_sites',
    title: 'List Web App Sites',
    description: 'List all web app sites with their files and sizes.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_site',
    title: 'Delete Web App Site',
    description:
      'Delete a web app site and all its files. You should re-deploy after deleting to remove it from Azure.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site_name: {
          type: 'string',
          description: 'Site name to delete',
        },
      },
      required: ['site_name'],
    },
  },
  {
    name: 'preview_web_app',
    title: 'Preview Web App',
    description:
      'Start a local HTTP server to preview a web app site. Returns a localhost URL you can navigate to with Playwright for visual testing. Auto-stops after 2 minutes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site_name: {
          type: 'string',
          description: 'Site name to preview',
        },
      },
      required: ['site_name'],
    },
  },
  {
    name: 'stop_preview',
    title: 'Stop Preview',
    description: 'Stop the local preview server.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'deploy_web_apps',
    title: 'Deploy Web Apps to Azure',
    description:
      'Deploy all web app sites to Azure Static Web Apps. Each site will be accessible at https://<app>.azurestaticapps.net/<site-name>/. Rate limited to prevent abuse.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveSiteDir(dir: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
      const filePath = path.join(dir, path.normalize(urlPath));

      // Prevent directory traversal
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

export const webAppsServer: McpServerDefinition = {
  serverName: 'signal-bot-webapps',
  configKey: 'webapps',
  entrypoint: 'webApps',
  tools: TOOLS,
  envMapping: {
    DB_PATH: 'dbPath',
    MCP_GROUP_ID: 'groupId',
    MCP_SENDER: 'sender',
    SWA_DEPLOYMENT_TOKEN: 'swaDeploymentToken',
    SWA_HOSTNAME: 'swaHostname',
    WEB_APPS_DIR: 'webAppsDir',
  },
  handlers: {
    write_web_app(args) {
      return catchErrors(() => {
        const name = requireString(args, 'site_name');
        if (name.error) return name.error;
        const content = requireString(args, 'content');
        if (content.error) return content.error;

        const nameError = validateSiteName(name.value);
        if (nameError) return error(nameError);

        if (content.value.length > MAX_FILE_SIZE) {
          return error(`Content exceeds maximum size of ${MAX_FILE_SIZE} bytes (1MB).`);
        }

        const filename = optionalString(args, 'filename', 'index.html');
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          return error('Invalid filename. Path traversal not allowed.');
        }

        const siteDir = getSiteDir(name.value);
        mkdirSync(siteDir, { recursive: true });
        writeFileSync(path.join(siteDir, filename), content.value, 'utf-8');

        return ok(`Wrote ${filename} to site "${name.value}" (${content.value.length} bytes).`);
      }, 'Failed to write web app');
    },

    read_web_app(args) {
      return catchErrors(() => {
        const name = requireString(args, 'site_name');
        if (name.error) return name.error;

        const nameError = validateSiteName(name.value);
        if (nameError) return error(nameError);

        const siteDir = getSiteDir(name.value);
        if (!existsSync(siteDir)) {
          return error(`Site "${name.value}" not found.`);
        }

        const filename = optionalString(args, 'filename', 'index.html');
        const filePath = path.join(siteDir, filename);
        if (!existsSync(filePath)) {
          return error(`File "${filename}" not found in site "${name.value}".`);
        }

        const content = readFileSync(filePath, 'utf-8');
        return ok(content);
      }, 'Failed to read web app');
    },

    edit_web_app(args) {
      return catchErrors(() => {
        const name = requireString(args, 'site_name');
        if (name.error) return name.error;
        const oldText = requireString(args, 'old_text');
        if (oldText.error) return oldText.error;
        const newText = requireString(args, 'new_text');
        if (newText.error) return newText.error;

        const nameError = validateSiteName(name.value);
        if (nameError) return error(nameError);

        const siteDir = getSiteDir(name.value);
        if (!existsSync(siteDir)) {
          return error(`Site "${name.value}" not found.`);
        }

        const filename = optionalString(args, 'filename', 'index.html');
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          return error('Invalid filename. Path traversal not allowed.');
        }

        const filePath = path.join(siteDir, filename);
        if (!existsSync(filePath)) {
          return error(`File "${filename}" not found in site "${name.value}".`);
        }

        const content = readFileSync(filePath, 'utf-8');

        // Count occurrences and track match position
        let count = 0;
        let matchIdx = -1;
        let searchFrom = 0;
        while (true) {
          const idx = content.indexOf(oldText.value, searchFrom);
          if (idx === -1) break;
          if (count === 0) matchIdx = idx;
          count++;
          searchFrom = idx + oldText.value.length;
        }

        if (count === 0) {
          return error(`Text not found in ${filename}. Check for exact whitespace/indentation match.`);
        }
        if (count > 1) {
          return error(
            `Text found ${count} times in ${filename}. Provide more surrounding context to make the match unique.`,
          );
        }

        const updated = content.replace(oldText.value, newText.value);
        writeFileSync(filePath, updated, 'utf-8');

        // Build context snippet: show ~3 lines around the edit
        const editIdx = matchIdx;
        const lines = updated.split('\n');
        let editLine = 0;
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1; // +1 for newline
          if (charCount > editIdx) {
            editLine = i;
            break;
          }
        }
        const snippetStart = Math.max(0, editLine - 1);
        const snippetEnd = Math.min(lines.length, editLine + 2);
        const snippet = lines.slice(snippetStart, snippetEnd).join('\n');

        return ok(
          `Edited ${filename} in site "${name.value}" (${updated.length} bytes).\n\nContext:\n${snippet}`,
        );
      }, 'Failed to edit web app');
    },

    list_sites() {
      return catchErrors(() => {
        if (!existsSync(sitesDir)) {
          return ok('No sites found.');
        }

        const entries = readdirSync(sitesDir, { withFileTypes: true }).filter(e => e.isDirectory());
        if (entries.length === 0) {
          return ok('No sites found.');
        }

        const lines = entries.map(entry => {
          const siteDir = path.join(sitesDir, entry.name);
          const files = readdirSync(siteDir);
          const totalSize = files.reduce((sum, f) => {
            const stat = statSync(path.join(siteDir, f));
            return sum + stat.size;
          }, 0);
          const sizeKb = (totalSize / 1024).toFixed(1);
          return `- **${entry.name}** — ${files.length} file(s), ${sizeKb} KB total\n  Files: ${files.join(', ')}`;
        });

        return ok(`Sites (${entries.length}):\n${lines.join('\n')}`);
      }, 'Failed to list sites');
    },

    delete_site(args) {
      return catchErrors(() => {
        const name = requireString(args, 'site_name');
        if (name.error) return name.error;

        const nameError = validateSiteName(name.value);
        if (nameError) return error(nameError);

        const siteDir = getSiteDir(name.value);
        if (!existsSync(siteDir)) {
          return error(`Site "${name.value}" not found.`);
        }

        rmSync(siteDir, { recursive: true, force: true });
        return ok(`Deleted site "${name.value}". Re-deploy to remove it from Azure.`);
      }, 'Failed to delete site');
    },

    async preview_web_app(args) {
      return catchErrors(async () => {
        const name = requireString(args, 'site_name');
        if (name.error) return name.error;

        const nameError = validateSiteName(name.value);
        if (nameError) return error(nameError);

        const siteDir = getSiteDir(name.value);
        if (!existsSync(siteDir)) {
          return error(`Site "${name.value}" not found. Write files first.`);
        }

        // Stop any existing preview
        stopPreviewServer();

        previewServer = await serveSiteDir(siteDir);
        const addr = previewServer.address() as { port: number };

        previewTimer = setTimeout(() => {
          stopPreviewServer();
        }, PREVIEW_TIMEOUT_MS);

        const url = `http://localhost:${addr.port}`;
        return ok(
          `Preview server running at ${url}\nNavigate to ${url}/index.html to view the site.\nAuto-stops in 2 minutes. Call stop_preview when done.`,
        );
      }, 'Failed to start preview');
    },

    stop_preview() {
      return catchErrors(() => {
        if (!previewServer) {
          return ok('No preview server running.');
        }
        stopPreviewServer();
        return ok('Preview server stopped.');
      }, 'Failed to stop preview');
    },

    async deploy_web_apps() {
      return withNotification(
        () => 'Deployed web apps to Azure',
        'deploy web apps',
        async () => {
          const token = process.env.SWA_DEPLOYMENT_TOKEN;
          if (!token) {
            return error('SWA_DEPLOYMENT_TOKEN is not configured. Set it in bot/.env to enable Azure deployment.');
          }

          if (!existsSync(sitesDir)) {
            return error('No sites to deploy. Write some files first.');
          }

          const entries = readdirSync(sitesDir, { withFileTypes: true }).filter(e => e.isDirectory());
          if (entries.length === 0) {
            return error('No sites to deploy. Write some files first.');
          }

          // Rate limiting
          const now = Date.now();
          const oneDayAgo = now - 24 * 60 * 60 * 1000;
          const oneHourAgo = now - 60 * 60 * 1000;

          const dailyCount = store.countDeploymentsSince(oneDayAgo);
          if (dailyCount >= DAILY_DEPLOY_LIMIT) {
            return error(`Daily deployment limit reached (${DAILY_DEPLOY_LIMIT}/day). Try again tomorrow.`);
          }

          if (groupId) {
            const hourlyCount = store.countGroupDeploymentsSince(groupId, oneHourAgo);
            if (hourlyCount >= HOURLY_GROUP_DEPLOY_LIMIT) {
              return error(
                `Hourly deployment limit reached for this group (${HOURLY_GROUP_DEPLOY_LIMIT}/hour). Try again later.`,
              );
            }
          }

          try {
            // SWA requires a root index.html — auto-generate a landing page
            const siteLinks = entries.map(e => `<li><a href="/${e.name}/">${e.name}</a></li>`).join('\n        ');
            const rootIndex = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Bot Sites</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center}
.wrap{max-width:400px;text-align:center}h1{margin-bottom:1.5rem;color:#7c3aed}ul{list-style:none}li{margin:.5rem 0}a{color:#60a5fa;text-decoration:none;font-size:1.2rem}a:hover{text-decoration:underline}</style>
</head><body><div class="wrap"><h1>Signal Bot Sites</h1><ul>${siteLinks}</ul></div></body></html>`;
            writeFileSync(path.join(sitesDir, 'index.html'), rootIndex, 'utf-8');

            const swaBin = resolveSwaCliPath();
            const { stdout, stderr } = await execFileAsync(
              swaBin,
              ['deploy', sitesDir, '--deployment-token', token, '--env', 'production'],
              { timeout: SWA_DEPLOY_TIMEOUT },
            );

            store.recordDeployment(groupId || 'unknown', process.env.MCP_SENDER || 'unknown', entries.length);

            const hostname = process.env.SWA_HOSTNAME || '';
            const siteList = entries
              .map(e => (hostname ? `- ${e.name}/ → https://${hostname}/${e.name}/` : `- ${e.name}/`))
              .join('\n');
            return ok(
              `Deployed ${entries.length} site(s) to Azure Static Web Apps.\n\nSites:\n${siteList}\n\n${stdout || stderr || 'Deployment complete.'}`,
            );
          } catch (err: unknown) {
            if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
              return error('SWA CLI not found. Install it with: npm install -g @azure/static-web-apps-cli');
            }
            throw err;
          }
        },
        'Deploy failed',
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new WebAppStore(conn);
    groupId = env.groupId;

    // Sites dir: use WEB_APPS_DIR env var, or default to sibling of DB dir
    sitesDir = process.env.WEB_APPS_DIR || path.join(path.dirname(env.dbPath), 'web-apps', 'sites');
    mkdirSync(sitesDir, { recursive: true });

    console.error(`Web Apps MCP server started (group: ${groupId || 'none'}, sites: ${sitesDir})`);
  },
  onClose() {
    stopPreviewServer();
    conn?.close();
  },
};

if (require.main === module) {
  runServer(webAppsServer);
}
