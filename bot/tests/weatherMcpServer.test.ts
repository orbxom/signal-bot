import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('Weather MCP Server', () => {
	let proc: ChildProcess | null = null;

	afterEach(() => {
		if (proc) {
			proc.kill();
			proc = null;
		}
	});

	function spawnMcpServer(): ChildProcess {
		proc = spawn('npx', ['tsx', join(__dirname, '../src/weatherMcpServer.ts')], {
			env: {
				...process.env,
				TZ: 'Australia/Sydney',
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return proc;
	}

	async function sendAndReceive(server: ChildProcess, message: object): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timeout waiting for MCP response')), 15000);
			const handler = (data: Buffer) => {
				const line = data.toString().trim();
				if (!line) return;
				try {
					const response = JSON.parse(line);
					clearTimeout(timeout);
					server.stdout!.removeListener('data', handler);
					resolve(response);
				} catch {
					// partial data, wait for more
				}
			};
			server.stdout!.on('data', handler);
			server.stdin!.write(`${JSON.stringify(message)}\n`);
		});
	}

	async function initializeServer(server: ChildProcess): Promise<void> {
		await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 0,
			method: 'initialize',
			params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
		});
		server.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	}

	it('should respond to initialize request', async () => {
		const server = spawnMcpServer();
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
		});

		expect(response.jsonrpc).toBe('2.0');
		expect(response.id).toBe(1);
		const result = response.result as Record<string, unknown>;
		expect(result.capabilities).toEqual({ tools: {} });
		const serverInfo = result.serverInfo as Record<string, string>;
		expect(serverInfo.name).toBe('signal-bot-weather');
	});

	it('should list 4 tools', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
		});

		const result = response.result as { tools: Array<{ name: string }> };
		expect(result.tools).toHaveLength(4);
		expect(result.tools.map(t => t.name)).toEqual([
			'search_location',
			'get_observations',
			'get_forecast',
			'get_warnings',
		]);
	});

	it('should return error for unknown tool', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'nonexistent_tool', arguments: {} },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Unknown tool');
	});

	it('should return error for unknown method', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 4,
			method: 'unknown/method',
		});

		expect(response.error).toBeDefined();
		const error = response.error as { code: number; message: string };
		expect(error.code).toBe(-32601);
	});

	it('should search for a location by name', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: { name: 'search_location', arguments: { query: 'Sydney' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain('geohash');
	});

	it('should reject short search queries', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'search_location', arguments: { query: 'ab' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('at least 3');
	});

	it('should get observations for a valid geohash', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);

		// r3gx2s is Sydney area (6-char geohash)
		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'get_observations', arguments: { geohash: 'r3gx2s' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain('Temperature');
	});

	it('should handle 7-char geohash for observations by trimming', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);

		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: { name: 'get_observations', arguments: { geohash: 'r3gx2sp' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain('Temperature');
	});

	it('should reject invalid geohash for observations', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);

		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: { name: 'get_observations', arguments: { geohash: 'ab' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('invalid geohash');
	});

	it('should get daily forecast', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);

		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 10,
			method: 'tools/call',
			params: { name: 'get_forecast', arguments: { geohash: 'r3gx2s' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain('forecast');
	});

	it('should get warnings or report none', async () => {
		const server = spawnMcpServer();
		await initializeServer(server);

		const response = await sendAndReceive(server, {
			jsonrpc: '2.0',
			id: 11,
			method: 'tools/call',
			params: { name: 'get_warnings', arguments: { geohash: 'r3gx2s' } },
		});

		const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBeFalsy();
		// Either has warnings or reports none — both are valid
		const text = result.content[0].text;
		expect(text.includes('warning') || text.includes('No active')).toBe(true);
	});
});
