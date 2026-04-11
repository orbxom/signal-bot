import { DatabaseConnection } from './db';
import { AttachmentStore } from './stores/attachmentStore';
import { DossierStore } from './stores/dossierStore';
import { GroupSettingsStore } from './stores/groupSettingsStore';
import { MemoryStore } from './stores/memoryStore';
import { MessageStore } from './stores/messageStore';
import { PersonaStore } from './stores/personaStore';
import { RecurringReminderStore } from './stores/recurringReminderStore';
import { ReminderStore } from './stores/reminderStore';
import type { Attachment, Dossier, MemoryWithTags, Message, Persona, Reminder, ReminderMode } from './types';

export class Storage {
  private _conn: DatabaseConnection;

  get conn(): DatabaseConnection {
    return this._conn;
  }
  readonly messages: MessageStore;
  readonly reminders: ReminderStore;
  readonly dossiers: DossierStore;
  readonly memories: MemoryStore;
  readonly personas: PersonaStore;
  readonly attachments: AttachmentStore;
  readonly recurringReminders: RecurringReminderStore;
  readonly groupSettings: GroupSettingsStore;

  constructor(dbPath: string) {
    this._conn = new DatabaseConnection(dbPath);
    this.messages = new MessageStore(this._conn);
    this.reminders = new ReminderStore(this._conn);
    this.dossiers = new DossierStore(this._conn);
    this.memories = new MemoryStore(this._conn);
    this.personas = new PersonaStore(this._conn);
    this.attachments = new AttachmentStore(this._conn);
    this.recurringReminders = new RecurringReminderStore(this._conn);
    this.groupSettings = new GroupSettingsStore(this._conn);

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

  createReminder(groupId: string, requester: string, reminderText: string, dueAt: number, mode?: ReminderMode): number {
    return this.reminders.create(groupId, requester, reminderText, dueAt, mode);
  }

  markReminderSent(id: number): boolean {
    return this.reminders.markSent(id);
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

  // === Memory methods (delegate to MemoryStore) ===
  getMemoriesByGroup(groupId: string): MemoryWithTags[] {
    return this.memories.getByGroup(groupId);
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

  // === Attachment methods (delegate to AttachmentStore) ===

  saveAttachment(attachment: Attachment): void {
    this.attachments.save(attachment);
  }

  getAttachment(id: string): Attachment | null {
    return this.attachments.get(id);
  }

  trimAttachments(cutoffTimestamp: number): void {
    this.attachments.trimOlderThan(cutoffTimestamp);
  }

  // === Lifecycle ===

  checkpoint(): void {
    this._conn.checkpoint();
  }

  close(): void {
    this._conn.close();
  }
}
