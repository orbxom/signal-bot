import { DatabaseConnection } from './db';
import { DossierStore } from './stores/dossierStore';
import { MessageStore } from './stores/messageStore';
import { PersonaStore } from './stores/personaStore';
import { ReminderStore } from './stores/reminderStore';
import type { Dossier, Message, Persona, Reminder } from './types';

export class Storage {
  private conn: DatabaseConnection;
  readonly messages: MessageStore;
  readonly reminders: ReminderStore;
  readonly dossiers: DossierStore;
  readonly personas: PersonaStore;

  constructor(dbPath: string) {
    this.conn = new DatabaseConnection(dbPath);
    this.messages = new MessageStore(this.conn);
    this.reminders = new ReminderStore(this.conn);
    this.dossiers = new DossierStore(this.conn);
    this.personas = new PersonaStore(this.conn);

    // Seed default persona (previously done in initTables)
    this.personas.seedDefault();
  }

  // === Message methods (delegate to MessageStore) ===

  addMessage(message: Omit<Message, 'id'>): void {
    this.messages.add(message);
  }

  getRecentMessages(groupId: string, limit: number): Message[] {
    return this.messages.getRecent(groupId, limit);
  }

  trimMessages(groupId: string, keepCount: number): void {
    this.messages.trim(groupId, keepCount);
  }

  getDistinctGroupIds(): string[] {
    return this.messages.getDistinctGroupIds();
  }

  searchMessages(
    groupId: string,
    keyword: string,
    options?: { sender?: string; startTimestamp?: number; endTimestamp?: number; limit?: number },
  ): Message[] {
    return this.messages.search(groupId, keyword, options);
  }

  getMessagesByDateRange(groupId: string, startTs: number, endTs: number, limit?: number): Message[] {
    return this.messages.getByDateRange(groupId, startTs, endTs, limit);
  }

  // === Reminder methods (delegate to ReminderStore) ===

  createReminder(groupId: string, requester: string, reminderText: string, dueAt: number): number {
    return this.reminders.create(groupId, requester, reminderText, dueAt);
  }

  getDueReminders(now?: number, limit = 50): Reminder[] {
    return this.reminders.getDueReminders(now, limit);
  }

  markReminderSent(id: number): boolean {
    return this.reminders.markSent(id);
  }

  markReminderFailed(id: number): boolean {
    return this.reminders.markFailedLegacy(id);
  }

  incrementReminderRetry(id: number): void {
    this.reminders.incrementRetry(id);
  }

  cancelReminder(id: number, groupId: string): boolean {
    return this.reminders.cancel(id, groupId);
  }

  listReminders(groupId: string): Reminder[] {
    return this.reminders.listPending(groupId);
  }

  // === Dossier methods (delegate to DossierStore) ===

  upsertDossier(groupId: string, personId: string, displayName: string, notes: string): Dossier {
    return this.dossiers.upsert(groupId, personId, displayName, notes);
  }

  getDossier(groupId: string, personId: string): Dossier | null {
    return this.dossiers.get(groupId, personId);
  }

  getDossiersByGroup(groupId: string): Dossier[] {
    return this.dossiers.getByGroup(groupId);
  }

  deleteDossier(groupId: string, personId: string): boolean {
    return this.dossiers.delete(groupId, personId);
  }

  // === Persona methods (delegate to PersonaStore) ===

  createPersona(name: string, description: string, tags: string): Persona {
    return this.personas.create(name, description, tags);
  }

  getPersona(id: number): Persona | null {
    return this.personas.getById(id);
  }

  getPersonaByName(name: string): Persona | null {
    return this.personas.getByName(name);
  }

  listPersonas(): Persona[] {
    return this.personas.list();
  }

  updatePersona(id: number, name: string, description: string, tags: string): boolean {
    return this.personas.update(id, name, description, tags);
  }

  deletePersona(id: number): boolean {
    return this.personas.delete(id);
  }

  getDefaultPersona(): Persona | null {
    return this.personas.getDefault();
  }

  setActivePersona(groupId: string, personaId: number): void {
    this.personas.setActive(groupId, personaId);
  }

  getActivePersonaForGroup(groupId: string): Persona | null {
    return this.personas.getActiveForGroup(groupId);
  }

  clearActivePersona(groupId: string): void {
    this.personas.clearActive(groupId);
  }

  // === Lifecycle ===

  close(): void {
    this.conn.close();
  }
}
