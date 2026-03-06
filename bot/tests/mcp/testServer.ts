import { error, ok } from '../../src/mcp/result';
import { runServer } from '../../src/mcp/runServer';
import type { McpServerDefinition } from '../../src/mcp/types';

const definition: McpServerDefinition = {
  serverName: 'test-server',
  configKey: 'test',
  entrypoint: 'testServer.ts',
  tools: [
    {
      name: 'greet',
      title: 'Greet',
      description: 'Greet someone by name',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet' },
        },
        required: ['name'],
      },
    },
    {
      name: 'fail',
      title: 'Fail',
      description: 'Always fails',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
  handlers: {
    greet: args => ok(`Hello, ${args.name}!`),
    fail: () => error('intentional failure'),
  },
  envMapping: {},
  onInit() {
    console.error('test-server initialized');
  },
};

runServer(definition);
