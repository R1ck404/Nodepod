// stub - not available in browser


import { EventEmitter } from "./events.js";

/* ------------------------------------------------------------------ */
/*  QuicEndpoint                                                       */
/* ------------------------------------------------------------------ */

export interface QuicEndpoint extends EventEmitter {
  close(): void;
  destroy(_err?: Error): void;
  readonly address: { address: string; family: string; port: number };
}

interface QuicEndpointConstructor {
  new (_opts?: object): QuicEndpoint;
  (this: any, _opts?: object): void;
  prototype: any;
}

export const QuicEndpoint = function QuicEndpoint(this: any, _opts?: object) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as QuicEndpointConstructor;

Object.setPrototypeOf(QuicEndpoint.prototype, EventEmitter.prototype);

QuicEndpoint.prototype.close = function close(this: any): void {
  this.emit("close");
};

QuicEndpoint.prototype.destroy = function destroy(this: any, _err?: Error): void {
  this.emit("close");
};

Object.defineProperty(QuicEndpoint.prototype, "address", {
  get: function(this: any): { address: string; family: string; port: number } {
    return { address: "0.0.0.0", family: "IPv4", port: 0 };
  },
  configurable: true,
});

/* ------------------------------------------------------------------ */
/*  QuicSession                                                        */
/* ------------------------------------------------------------------ */

export interface QuicSession extends EventEmitter {
  close(): void;
  destroy(_err?: Error): void;
  readonly destroyed: boolean;
}

interface QuicSessionConstructor {
  new (): QuicSession;
  (this: any): void;
  prototype: any;
}

export const QuicSession = function QuicSession(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as QuicSessionConstructor;

Object.setPrototypeOf(QuicSession.prototype, EventEmitter.prototype);

QuicSession.prototype.close = function close(this: any): void {
  this.emit("close");
};

QuicSession.prototype.destroy = function destroy(this: any, _err?: Error): void {
  this.emit("close");
};

Object.defineProperty(QuicSession.prototype, "destroyed", {
  get: function(this: any): boolean {
    return false;
  },
  configurable: true,
});

/* ------------------------------------------------------------------ */
/*  QuicStream                                                         */
/* ------------------------------------------------------------------ */

export interface QuicStream extends EventEmitter {
  readonly id: number;
}

interface QuicStreamConstructor {
  new (): QuicStream;
  (this: any): void;
  prototype: any;
}

export const QuicStream = function QuicStream(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as QuicStreamConstructor;

Object.setPrototypeOf(QuicStream.prototype, EventEmitter.prototype);

Object.defineProperty(QuicStream.prototype, "id", {
  get: function(this: any): number {
    return 0;
  },
  configurable: true,
});

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  QuicEndpoint,
  QuicSession,
  QuicStream,
};
