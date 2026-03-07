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
    const lowerContent = query.toLowerCase();
    // Only strip the trigger that matched at position 0
    for (let i = 0; i < this.lowerTriggers.length; i++) {
      if (lowerContent.startsWith(this.lowerTriggers[i])) {
        query = query.slice(this.triggers[i].length);
        break;
      }
    }
    return query.replace(/\s+/g, ' ').trim();
  }
}
