export class MessageDeduplicator {
  private seen = new Map<string, true>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  isDuplicate(groupId: string, sender: string, timestamp: number): boolean {
    const key = `${groupId}:${sender}:${timestamp}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, true);
    // Evict oldest one at a time (Map preserves insertion order)
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return false;
  }
}
