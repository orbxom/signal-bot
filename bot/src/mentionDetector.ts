export class MentionDetector {
  private triggers: string[];
  private lowerTriggers: string[];

  constructor(triggers: string[]) {
    this.triggers = triggers;
    this.lowerTriggers = triggers.map(t => t.toLowerCase());
  }

  isMentioned(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return this.lowerTriggers.some(trigger => lowerContent.startsWith(trigger));
  }

  extractQuery(content: string): string {
    let query = content;
    for (let i = 0; i < this.triggers.length; i++) {
      const trigger = this.triggers[i];
      // Case-insensitive removal without regex to avoid injection
      const lowerTrigger = this.lowerTriggers[i];
      let lowerQuery = query.toLowerCase();
      let idx = lowerQuery.indexOf(lowerTrigger);
      while (idx !== -1) {
        query = query.slice(0, idx) + query.slice(idx + trigger.length);
        lowerQuery = query.toLowerCase();
        idx = lowerQuery.indexOf(lowerTrigger, idx);
      }
    }
    return query.replace(/\s+/g, ' ').trim();
  }
}
