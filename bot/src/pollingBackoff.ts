interface PollingBackoffOptions {
  baseDelay?: number;
  maxDelay?: number;
  reconnectThreshold?: number;
}

export class PollingBackoff {
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly reconnectThreshold: number;
  private errorCount = 0;

  constructor(options: PollingBackoffOptions = {}) {
    this.baseDelay = options.baseDelay ?? 2000;
    this.maxDelay = options.maxDelay ?? 60000;
    this.reconnectThreshold = options.reconnectThreshold ?? 5;
  }

  recordError(): void {
    this.errorCount++;
  }

  recordSuccess(): void {
    if (this.errorCount > 0) this.errorCount = 0;
  }

  getDelay(): number {
    if (this.errorCount === 0) return this.baseDelay;
    return Math.min(this.baseDelay * 2 ** this.errorCount, this.maxDelay);
  }

  shouldReconnect(): boolean {
    return this.errorCount > 0 && this.errorCount % this.reconnectThreshold === 0;
  }
}
