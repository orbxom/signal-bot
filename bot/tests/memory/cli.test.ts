import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliPath = join(__dirname, '../../src/memory/cli.ts');
let dbPath: string;
let tmpDir: string;

function run(args: string): string {
  return execSync(`npx tsx ${cliPath} ${args}`, {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memory-cli-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('memory cli', () => {
  const group = 'group-123';

  it('saves a memory and returns confirmation', () => {
    const out = run(`save --group ${group} --title "Pizza Place" --type url --content http://pizza.com --description "Dad loves this" --tags family,food`);
    expect(out).toContain('Pizza Place');
    expect(out).not.toMatch(/^\{/); // not JSON
  });

  it('search returns saved memory in plain text format', () => {
    run(`save --group ${group} --title "Pizza Place" --type url --content http://pizza.com --description "Dad loves this" --tags family,food`);
    const out = run(`search --group ${group}`);
    expect(out).toContain('Pizza Place');
    expect(out).toContain('[url]');
    expect(out).toContain('Description: Dad loves this');
    expect(out).toContain('Content: http://pizza.com');
    expect(out).toContain('Tags: family, food');
    expect(out).not.toMatch(/^\{/); // not JSON
  });

  it('search with keyword filter returns matching memory', () => {
    run(`save --group ${group} --title "Pizza Place" --type url --content http://pizza.com`);
    run(`save --group ${group} --title "Car Mechanic" --type contact --content "John 0400111222"`);
    const out = run(`search --group ${group} --keyword pizza`);
    expect(out).toContain('Pizza Place');
    expect(out).not.toContain('Car Mechanic');
  });

  it('search with type filter returns matching memory', () => {
    run(`save --group ${group} --title "Pizza Place" --type url --content http://pizza.com`);
    run(`save --group ${group} --title "Car Mechanic" --type contact --content "John 0400111222"`);
    const out = run(`search --group ${group} --type contact`);
    expect(out).not.toContain('Pizza Place');
    expect(out).toContain('Car Mechanic');
  });

  it('search with tag filter returns matching memory', () => {
    run(`save --group ${group} --title "Pizza Place" --type url --tags family,food`);
    run(`save --group ${group} --title "Work Tool" --type url --tags work`);
    const out = run(`search --group ${group} --tag family`);
    expect(out).toContain('Pizza Place');
    expect(out).not.toContain('Work Tool');
  });

  it('search with no results returns empty message', () => {
    const out = run(`search --group ${group}`);
    expect(out).toBe('No memories found.');
  });

  it('list-types returns types in use', () => {
    run(`save --group ${group} --title "Pizza" --type url`);
    run(`save --group ${group} --title "John" --type contact`);
    const out = run(`list-types --group ${group}`);
    expect(out).toContain('contact');
    expect(out).toContain('url');
    expect(out).not.toMatch(/^\{/); // not JSON
  });

  it('list-types with no data returns empty message', () => {
    const out = run(`list-types --group ${group}`);
    expect(out).toBe('No types in use.');
  });

  it('list-tags returns tags in use', () => {
    run(`save --group ${group} --title "Pizza" --type url --tags family,food`);
    const out = run(`list-tags --group ${group}`);
    expect(out).toContain('family');
    expect(out).toContain('food');
    expect(out).not.toMatch(/^\{/); // not JSON
  });

  it('list-tags with no data returns empty message', () => {
    const out = run(`list-tags --group ${group}`);
    expect(out).toBe('No tags in use.');
  });

  it('delete removes a memory', () => {
    run(`save --group ${group} --title "Pizza Place" --type url`);
    // Get the id from the search output
    const searchOut = run(`search --group ${group}`);
    const match = searchOut.match(/#(\d+)/);
    expect(match).not.toBeNull();
    const id = match![1];
    const deleteOut = run(`delete --group ${group} --id ${id}`);
    expect(deleteOut).toContain('Deleted');
    const afterDelete = run(`search --group ${group}`);
    expect(afterDelete).toBe('No memories found.');
  });

  it('output is plain text, not JSON', () => {
    run(`save --group ${group} --title "Test" --type note --content "hello"`);
    const out = run(`search --group ${group}`);
    // Should not be parseable as JSON
    expect(() => JSON.parse(out)).toThrow();
  });

  it('memory without optional fields shows minimal output', () => {
    run(`save --group ${group} --title "Bare Memory" --type note`);
    const out = run(`search --group ${group}`);
    expect(out).toContain('Bare Memory');
    expect(out).toContain('[note]');
    expect(out).not.toContain('Description:');
    expect(out).not.toContain('Content:');
    expect(out).not.toContain('Tags:');
  });
});
