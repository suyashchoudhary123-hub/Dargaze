import { io, type Socket } from 'socket.io-client';

export type AckResult<T = Record<string, unknown>> = { ok: boolean; error?: string } & T;
type Listener = (...args: any[]) => void;

export class NetworkClient {
  private socket: Socket | null = null;
  private token = '';

  connect(token: string): Socket {
    if (this.socket && this.token === token) {
      if (!this.socket.connected) this.socket.connect();
      return this.socket;
    }
    this.disconnect();
    this.token = token;
    this.socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 6000,
      timeout: 10_000,
    });
    this.socket.connect();
    return this.socket;
  }

  updateToken(token: string): void {
    if (this.token === token) return;
    const wasConnected = this.socket?.connected ?? false;
    this.token = token;
    if (this.socket) {
      this.socket.auth = { token };
      if (wasConnected) this.socket.disconnect();
      this.socket.connect();
    }
  }

  get connected(): boolean { return this.socket?.connected ?? false; }
  get raw(): Socket | null { return this.socket; }

  on(event: string, listener: Listener): void { this.socket?.on(event, listener); }
  off(event: string, listener?: Listener): void { this.socket?.off(event, listener); }

  emitAck<T = unknown>(event: string, payload: unknown, timeoutMs = 8000): Promise<AckResult<T>> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) { reject(new Error('Not connected to the Dargaze server')); return; }
      const timer = window.setTimeout(() => reject(new Error('The server took too long to respond')), timeoutMs);
      this.socket.emit(event, payload, (result: AckResult<T>) => {
        window.clearTimeout(timer);
        if (!result || result.ok !== true) reject(new Error(result?.error ?? 'The request was rejected'));
        else resolve(result);
      });
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners(); this.socket.disconnect(); this.socket = null; this.token = '';
  }
}
