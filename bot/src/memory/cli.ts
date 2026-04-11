import { DatabaseConnection } from '../db';
import { MemoryStore } from '../stores/memoryStore';
import { formatMemory } from './format';

const DB_PATH = process.env.DB_PATH || './data/bot.db';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || '';
  const flags: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
      flags[key] = value;
      if (value) i++;
    }
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  const { command, flags } = parseArgs(process.argv);

  const conn = new DatabaseConnection(DB_PATH);
  const store = new MemoryStore(conn);

  try {
    switch (command) {
      case 'save': {
        const group = requireFlag(flags, 'group');
        const title = requireFlag(flags, 'title');
        const type = requireFlag(flags, 'type');

        const tags = flags.tags
          ? flags.tags
              .split(',')
              .map(t => t.trim())
              .filter(Boolean)
          : undefined;
        const mem = store.save(group, title, type, {
          description: flags.description || undefined,
          content: flags.content || undefined,
          tags,
        });
        console.log(formatMemory(mem));
        break;
      }

      case 'search': {
        const group = requireFlag(flags, 'group');

        const results = store.search(group, {
          keyword: flags.keyword || undefined,
          type: flags.type || undefined,
          tag: flags.tag || undefined,
        });

        if (results.length === 0) {
          console.log('No memories found.');
        } else {
          console.log(results.map(m => formatMemory(m)).join('\n\n'));
        }
        break;
      }

      case 'list-types': {
        const group = requireFlag(flags, 'group');

        const types = store.listTypes(group);
        if (types.length === 0) {
          console.log('No types in use.');
        } else {
          console.log(types.join('\n'));
        }
        break;
      }

      case 'list-tags': {
        const group = requireFlag(flags, 'group');

        const tags = store.listTags(group);
        if (tags.length === 0) {
          console.log('No tags in use.');
        } else {
          console.log(tags.join('\n'));
        }
        break;
      }

      case 'delete': {
        const { id } = flags;
        if (!id) {
          console.error('Error: --id is required');
          process.exit(1);
        }

        const memId = Number.parseInt(id, 10);
        if (Number.isNaN(memId)) {
          console.error('Error: --id must be a number');
          process.exit(1);
        }

        const deleted = store.deleteById(memId);
        if (deleted) {
          console.log(`Deleted memory #${memId}`);
        } else {
          console.log(`No memory found with id ${memId}`);
        }
        break;
      }

      default: {
        console.error(`Unknown command: ${command}`);
        console.error('Usage: cli.ts <save|search|list-types|list-tags|delete> [flags]');
        process.exit(1);
      }
    }
  } finally {
    conn.close();
  }
}

main();
