import { DatabaseConnection } from '../db';
import { MemoryStore } from '../stores/memoryStore';

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

function formatMemory(index: number, mem: { id: number; title: string; type: string; description?: string | null; content?: string | null; tags?: string[] }): string {
  const lines: string[] = [];
  lines.push(`#${mem.id} "${mem.title}" [${mem.type}]`);
  if (mem.description) {
    lines.push(`  Description: ${mem.description}`);
  }
  if (mem.content) {
    lines.push(`  Content: ${mem.content}`);
  }
  if (mem.tags && mem.tags.length > 0) {
    lines.push(`  Tags: ${mem.tags.join(', ')}`);
  }
  return lines.join('\n');
}

function main(): void {
  const { command, flags } = parseArgs(process.argv);

  const conn = new DatabaseConnection(DB_PATH);
  const store = new MemoryStore(conn);

  try {
    switch (command) {
      case 'save': {
        const { group, title, type } = flags;
        if (!group) { console.error('Error: --group is required'); process.exit(1); }
        if (!title) { console.error('Error: --title is required'); process.exit(1); }
        if (!type) { console.error('Error: --type is required'); process.exit(1); }

        const tags = flags.tags ? flags.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined;
        const mem = store.save(group, title, type, {
          description: flags.description || undefined,
          content: flags.content || undefined,
          tags,
        });
        console.log(formatMemory(mem.id, mem));
        break;
      }

      case 'search': {
        const { group } = flags;
        if (!group) { console.error('Error: --group is required'); process.exit(1); }

        const results = store.search(group, {
          keyword: flags.keyword || undefined,
          type: flags.type || undefined,
          tag: flags.tag || undefined,
        });

        if (results.length === 0) {
          console.log('No memories found.');
        } else {
          console.log(results.map((m, i) => formatMemory(i + 1, m)).join('\n\n'));
        }
        break;
      }

      case 'list-types': {
        const { group } = flags;
        if (!group) { console.error('Error: --group is required'); process.exit(1); }

        const types = store.listTypes(group);
        if (types.length === 0) {
          console.log('No types in use.');
        } else {
          console.log(types.join('\n'));
        }
        break;
      }

      case 'list-tags': {
        const { group } = flags;
        if (!group) { console.error('Error: --group is required'); process.exit(1); }

        const tags = store.listTags(group);
        if (tags.length === 0) {
          console.log('No tags in use.');
        } else {
          console.log(tags.join('\n'));
        }
        break;
      }

      case 'delete': {
        const { group, id } = flags;
        if (!group) { console.error('Error: --group is required'); process.exit(1); }
        if (!id) { console.error('Error: --id is required'); process.exit(1); }

        const memId = Number.parseInt(id, 10);
        if (Number.isNaN(memId)) { console.error('Error: --id must be a number'); process.exit(1); }

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
