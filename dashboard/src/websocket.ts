import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

export interface WsEvent {
  type: string;
  data: unknown;
}

export class WebSocketHub {
  private wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.on('error', (err) => console.error('WebSocket error:', err));
    });
  }

  broadcast(event: WsEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
