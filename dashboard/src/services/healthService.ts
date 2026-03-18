import fs from 'node:fs';
import type { Storage } from '../../../bot/src/storage';
import type { SignalClient } from '../../../bot/src/signalClient';

export class HealthService {
  private startTime = Date.now();

  constructor(
    private storage: Storage,
    private signalClient: SignalClient,
    private dbPath: string,
  ) {}

  async getHealth(): Promise<{
    uptime: number;
    memory: NodeJS.MemoryUsage;
    dbSize: number;
    signalCliReachable: boolean;
  }> {
    let signalCliReachable = false;
    try {
      await this.signalClient.listGroups();
      signalCliReachable = true;
    } catch {
      // signal-cli unreachable
    }

    let dbSize = 0;
    try {
      const stat = fs.statSync(this.dbPath);
      dbSize = stat.size;
    } catch {
      // DB file not found
    }

    return {
      uptime: Date.now() - this.startTime,
      memory: process.memoryUsage(),
      dbSize,
      signalCliReachable,
    };
  }
}
