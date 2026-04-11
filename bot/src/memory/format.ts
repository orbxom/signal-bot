import type { MemoryWithTags } from '../types';

export function formatMemory(m: MemoryWithTags): string {
  const lines = [`#${m.id} "${m.title}" [${m.type}]`];
  if (m.description) lines.push(`  Description: ${m.description}`);
  if (m.content) lines.push(`  Content: ${m.content}`);
  if (m.tags.length > 0) lines.push(`  Tags: ${m.tags.join(', ')}`);
  return lines.join('\n');
}
