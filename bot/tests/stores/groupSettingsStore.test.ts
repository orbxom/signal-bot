import { afterEach, describe, expect, it } from 'vitest'
import { GroupSettingsStore } from '../../src/stores/groupSettingsStore'
import { createTestDb, type TestDb } from '../helpers/testDb'

describe('GroupSettingsStore', () => {
  let db: TestDb

  afterEach(() => db?.cleanup())

  const setup = () => {
    db = createTestDb('group-settings-')
    return new GroupSettingsStore(db.conn)
  }

  it('returns default settings for unknown group', () => {
    const store = setup()
    const settings = store.get('unknown-group')
    expect(settings).toBeNull()
  })

  it('isEnabled returns true for unknown group', () => {
    const store = setup()
    expect(store.isEnabled('unknown-group')).toBe(true)
  })

  it('upserts and retrieves settings', () => {
    const store = setup()
    store.upsert('group1', { enabled: false, toolNotifications: true })
    const settings = store.get('group1')
    expect(settings).not.toBeNull()
    expect(settings!.enabled).toBe(false)
    expect(settings!.toolNotifications).toBe(true)
    expect(settings!.customTriggers).toBeNull()
    expect(settings!.contextWindowSize).toBeNull()
  })

  it('isEnabled returns false for disabled group', () => {
    const store = setup()
    store.upsert('group1', { enabled: false })
    expect(store.isEnabled('group1')).toBe(false)
  })

  it('upserts custom triggers as JSON', () => {
    const store = setup()
    store.upsert('group1', { customTriggers: ['@bot', 'hey bot'] })
    const triggers = store.getTriggers('group1')
    expect(triggers).toEqual(['@bot', 'hey bot'])
  })

  it('getTriggers returns null for unknown group', () => {
    const store = setup()
    expect(store.getTriggers('unknown')).toBeNull()
  })

  it('getToolNotifications returns true by default', () => {
    const store = setup()
    expect(store.getToolNotifications('group1')).toBe(true)
  })

  it('updates existing settings', () => {
    const store = setup()
    store.upsert('group1', { enabled: true })
    store.upsert('group1', { enabled: false, contextWindowSize: 100 })
    const settings = store.get('group1')
    expect(settings!.enabled).toBe(false)
    expect(settings!.contextWindowSize).toBe(100)
  })
})
