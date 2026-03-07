import { afterEach, describe, expect, it } from 'vitest';
import { ToolNotificationStore } from '../../src/stores/toolNotificationStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('ToolNotificationStore', () => {
  let db: TestDb;
  let store: ToolNotificationStore;

  const setup = () => {
    db = createTestDb('signal-bot-tool-notification-store-test-');
    store = new ToolNotificationStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  it('returns false for unknown group (default off)', () => {
    setup();
    expect(store.isEnabled('group-1')).toBe(false);
  });

  it('enables notifications for a group', () => {
    setup();
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
  });

  it('disables notifications for a group', () => {
    setup();
    store.setEnabled('group-1', true);
    store.setEnabled('group-1', false);
    expect(store.isEnabled('group-1')).toBe(false);
  });

  it('isolates settings per group', () => {
    setup();
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
    expect(store.isEnabled('group-2')).toBe(false);
  });

  it('upserts on repeated calls', () => {
    setup();
    store.setEnabled('group-1', true);
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
  });
});
