import { logger } from './logger';
import { MentionDetector } from './mentionDetector';
import type { MessageDeduplicator } from './messageDeduplicator';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { ExtractedMessage, MentionRequest, QueueItem } from './types';

export const REALTIME_THRESHOLD_MS = 5000;

export interface IngestOptions {
  messages: ExtractedMessage[];
  mentionTriggers: string[];
  botPhoneNumber: string;
  storage: Storage;
  signalClient: SignalClient;
  enqueue: (item: QueueItem) => void;
  storeOnlyGroupIds?: Set<string>;
  realtimeThresholdMs?: number;
  deduplicator?: MessageDeduplicator;
  attachmentsDir?: string;
}

export function ingestMessages(options: IngestOptions): void {
  const {
    messages,
    mentionTriggers,
    botPhoneNumber,
    storage,
    signalClient,
    enqueue,
    storeOnlyGroupIds,
    attachmentsDir,
  } = options;
  const realtimeThresholdMs = options.realtimeThresholdMs ?? REALTIME_THRESHOLD_MS;
  const deduplicator = options.deduplicator;
  const defaultDetector = new MentionDetector(mentionTriggers);

  // Group messages by groupId, filtering bot-self and duplicates
  const byGroup = new Map<string, ExtractedMessage[]>();
  for (const msg of messages) {
    if (botPhoneNumber && msg.sender === botPhoneNumber) continue;
    if (deduplicator?.isDuplicate(msg.groupId, msg.sender, msg.timestamp)) continue;

    if (!byGroup.has(msg.groupId)) byGroup.set(msg.groupId, []);
    byGroup.get(msg.groupId)?.push(msg);
  }

  const now = Date.now();

  for (const [groupId, groupMessages] of byGroup) {
    const isStoreOnly = storeOnlyGroupIds?.has(groupId) ?? false;
    const isEnabled = storage.groupSettings.isEnabled(groupId);

    // Store all messages
    for (const msg of groupMessages) {
      storage.addMessage({
        groupId: msg.groupId,
        sender: msg.sender,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: false,
        attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
      });
    }

    // Ingest image attachments (skip for storeOnly and disabled groups)
    if (!isStoreOnly && isEnabled && attachmentsDir) {
      for (const msg of groupMessages) {
        for (const att of msg.attachments) {
          if (att.contentType.startsWith('image/')) {
            const file = signalClient.readAttachmentFile(attachmentsDir, att.id);
            if (file) {
              storage.saveAttachment({
                id: att.id,
                groupId,
                sender: msg.sender,
                contentType: att.contentType,
                size: att.size,
                filename: att.filename,
                data: file.data,
                timestamp: msg.timestamp,
              });
            }
          }
        }
      }
    }

    // Don't enqueue for storeOnly or disabled groups
    if (isStoreOnly || !isEnabled) continue;

    // Detect mentions using per-group triggers or defaults
    const customTriggers = storage.groupSettings.getTriggers(groupId);
    const detector = customTriggers ? new MentionDetector(customTriggers) : defaultDetector;

    const mentionMessages = groupMessages.filter(msg => detector.isMentioned(msg.content));
    if (mentionMessages.length === 0) continue;

    // Classify missed vs realtime
    const missed = mentionMessages.filter(m => now - m.timestamp > realtimeThresholdMs);
    const realtime = mentionMessages.filter(m => now - m.timestamp <= realtimeThresholdMs);

    // Coalesce missed mentions
    if (missed.length > 1) {
      const missedFraming = buildMissedFraming(missed, now);
      const requests: MentionRequest[] = missed.map(m => toMentionRequest(m));
      enqueue({ kind: 'coalesced', requests, missedFraming });
      logger.debug(`Coalesced ${missed.length} missed mentions for group ${groupId}`);
    } else if (missed.length === 1) {
      enqueue({ kind: 'single', request: toMentionRequest(missed[0]) });
    }

    // Enqueue realtime mentions individually
    for (const msg of realtime) {
      enqueue({ kind: 'single', request: toMentionRequest(msg) });
    }
  }
}

function toMentionRequest(msg: ExtractedMessage): MentionRequest {
  return {
    groupId: msg.groupId,
    sender: msg.sender,
    content: msg.content,
    attachments: msg.attachments,
    timestamp: msg.timestamp,
  };
}

function buildMissedFraming(missed: ExtractedMessage[], now: number): string {
  const lines = missed.map(m => {
    const agoSeconds = Math.round((now - m.timestamp) / 1000);
    let agoStr: string;
    if (agoSeconds < 60) {
      agoStr = `${agoSeconds}s ago`;
    } else if (agoSeconds < 3600) {
      agoStr = `${Math.round(agoSeconds / 60)} min ago`;
    } else {
      agoStr = `${Math.round(agoSeconds / 3600)}h ago`;
    }
    return `- [${m.sender}] (${agoStr}): "${m.content}"`;
  });
  return `You were offline and missed the following messages:\n${lines.join('\n')}\n\nRespond to all of these in a single message.`;
}
