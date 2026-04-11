import { afterEach, describe, expect, it } from 'vitest';
import { WebAppStore } from '../../src/stores/webAppStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('WebAppStore', () => {
  let db: TestDb;
  let store: WebAppStore;

  const setup = () => {
    db = createTestDb('signal-bot-webapp-store-test-');
    store = new WebAppStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  describe('recordDeployment', () => {
    it('should record a deployment', () => {
      setup();
      store.recordDeployment('group1', 'sender1', 3);
      const deployments = store.getDeployments();
      expect(deployments).toHaveLength(1);
      expect(deployments[0]).toMatchObject({
        groupId: 'group1',
        sender: 'sender1',
        siteCount: 3,
      });
      expect(deployments[0].deployedAt).toBeGreaterThan(0);
    });

    it('should record multiple deployments', () => {
      setup();
      store.recordDeployment('group1', 'sender1', 2);
      store.recordDeployment('group2', 'sender2', 1);
      const deployments = store.getDeployments();
      expect(deployments).toHaveLength(2);
    });
  });

  describe('getDeployments', () => {
    it('should return empty array when no deployments', () => {
      setup();
      expect(store.getDeployments()).toEqual([]);
    });

    it('should respect limit parameter', () => {
      setup();
      for (let i = 0; i < 5; i++) {
        store.recordDeployment('group1', 'sender1', 1);
      }
      expect(store.getDeployments(3)).toHaveLength(3);
    });

    it('should return most recent first', () => {
      setup();
      store.recordDeployment('group1', 'sender1', 1);
      store.recordDeployment('group1', 'sender1', 5);
      const deployments = store.getDeployments();
      expect(deployments[0].siteCount).toBe(5);
      expect(deployments[1].siteCount).toBe(1);
    });
  });

  describe('countDeploymentsSince', () => {
    it('should return 0 when no deployments', () => {
      setup();
      expect(store.countDeploymentsSince(0)).toBe(0);
    });

    it('should count deployments since a given timestamp', () => {
      setup();
      const before = Date.now() - 1;
      store.recordDeployment('group1', 'sender1', 1);
      store.recordDeployment('group2', 'sender2', 2);
      expect(store.countDeploymentsSince(before)).toBe(2);
    });

    it('should not count deployments before the timestamp', () => {
      setup();
      store.recordDeployment('group1', 'sender1', 1);
      const after = Date.now() + 1000;
      expect(store.countDeploymentsSince(after)).toBe(0);
    });
  });

  describe('countGroupDeploymentsSince', () => {
    it('should count only deployments for a specific group', () => {
      setup();
      const before = Date.now() - 1;
      store.recordDeployment('group1', 'sender1', 1);
      store.recordDeployment('group2', 'sender2', 1);
      store.recordDeployment('group1', 'sender1', 1);
      expect(store.countGroupDeploymentsSince('group1', before)).toBe(2);
      expect(store.countGroupDeploymentsSince('group2', before)).toBe(1);
    });
  });
});
