// Stream polyfill -- Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished.
// Uses function constructors (not classes) so Readable.call(this) works for pre-ES6 inheritance.

import { EventEmitter } from "./events";
import { Buffer } from "./buffer";

function bufferByteLength(chunk: unknown): number {
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  return 0;
}

// Readable

export interface Readable extends EventEmitter {
  readable: boolean;
  readableEnded: boolean;
  readableFlowing: boolean | null;
  destroyed: boolean;
  closed: boolean;
  errored: Error | null;
  readableObjectMode: boolean;
  readableHighWaterMark: number;
  readableDidRead: boolean;
  readableAborted: boolean;
  _readableState: any;
  _read(size: number): void;
  _destroy(err: Error | null, cb: (err?: Error | null) => void): void;
  readonly readableLength: number;
  readonly readableEncoding: BufferEncoding | null;
  _rawBind(evt: string | symbol, fn: (...args: unknown[]) => void): this;
  on(evt: string | symbol, fn: (...args: any[]) => void): this;
  addListener(evt: string | symbol, fn: (...args: any[]) => void): this;
  once(evt: string | symbol, fn: (...args: any[]) => void): this;
  push(chunk: any): boolean;
  unshift(chunk: any): void;
  read(amount?: number): any;
  resume(): this;
  pause(): this;
  isPaused(): boolean;
  pipe(target: any): any;
  unpipe(target?: any): this;
  setEncoding(enc: string): this;
  close(cb?: (err?: Error | null) => void): void;
  destroy(fault?: Error): this;
  wrap(oldStream: EventEmitter): this;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

interface ReadableConstructor {
  new (opts?: any): Readable;
  (this: any, opts?: any): void;
  prototype: any;
  toWeb(readable: Readable): ReadableStream<Uint8Array>;
  fromWeb(webStream: ReadableStream, opts?: any): Readable;
  from(source: Iterable<unknown> | AsyncIterable<unknown>, opts?: any): Readable;
}

export const Readable = function Readable(this: any, opts?: any) {
  if (!this) return;
  EventEmitter.call(this);

  this._queue = [];
  this._terminated = false;
  this._active = false;
  this._endFired = false;
  this._endEmitted = false;
  this._objectMode = false;
  this._reading = false;
  this._highWaterMark = 16384;
  this._autoDestroy = true;
  this._encoding = null;
  this._readableByteLength = 0;
  this._draining = false;

  this.readable = true;
  this.readableEnded = false;
  this.readableFlowing = null;
  this.destroyed = false;
  this.closed = false;
  this.errored = null;
  this.readableObjectMode = false;
  this.readableHighWaterMark = 16384;
  this.readableDidRead = false;
  this.readableAborted = false;

  // _readableState proxy so libs like readable-stream can inspect internals
  const self = this;
  this._readableState = {
    get objectMode() { return self._objectMode; },
    get highWaterMark() { return self._highWaterMark; },
    get ended() { return self._terminated; },
    get endEmitted() { return self._endEmitted; },
    set endEmitted(v: boolean) { self._endEmitted = v; },
    get flowing() { return self.readableFlowing; },
    set flowing(v: boolean | null) { self.readableFlowing = v; },
    get reading() { return self._reading; },
    get length() { return self.readableLength; },
    get destroyed() { return self.destroyed; },
    get errored() { return self.errored; },
    get closed() { return self.closed; },
    pipes: [],
    awaitDrainWriters: null,
    multiAwaitDrain: false,
    readableListening: false,
    resumeScheduled: false,
    paused: true,
    emitClose: true,
    get autoDestroy() { return self._autoDestroy; },
    defaultEncoding: "utf8",
    needReadable: false,
    emittedReadable: false,
    readingMore: false,
    dataEmitted: false,
  };

  if (opts) {
    if (opts.objectMode) {
      this._objectMode = true;
      this.readableObjectMode = true;
      if (opts.highWaterMark === undefined) {
        this._highWaterMark = 16;
        this.readableHighWaterMark = 16;
      }
    }
    if (opts.highWaterMark !== undefined) {
      this._highWaterMark = opts.highWaterMark;
      this.readableHighWaterMark = opts.highWaterMark;
    }
    if (opts.autoDestroy !== undefined) {
      this._autoDestroy = opts.autoDestroy;
    }
    if (opts.read) {
      this._read = opts.read.bind(this);
    }
    if (opts.destroy) {
      this._destroy = opts.destroy.bind(this);
    }
  }
} as unknown as ReadableConstructor;

Object.setPrototypeOf(Readable.prototype, EventEmitter.prototype);

Readable.prototype._read = function _read(_size: number): void {};

Readable.prototype._destroy = function _destroy(
  err: Error | null,
  callback: (err?: Error | null) => void,
): void {
  callback(err);
};

// skips auto-flow logic so internal listeners don't trigger resume()
Readable.prototype._rawBind = function _rawBind(
  evt: string | symbol,
  fn: (...args: unknown[]) => void,
): any {
  EventEmitter.prototype.addListener.call(this, evt as string, fn);
  return this;
};

Readable.prototype.on = function on(
  evt: string | symbol,
  fn: (...args: unknown[]) => void,
): any {
  this._rawBind(evt, fn);
  if (evt === "data" && !this._active) {
    this.resume();
  }
  if (evt === "readable") {
    this.readableFlowing = false;
  }
  // fire late 'end' listeners async (matches Node.js behavior)
  if (evt === "end" && this._endEmitted) {
    queueMicrotask(() => fn());
  } else if (evt === "end" && this._terminated && this._queue.length === 0 && !this._endFired) {
    this._endFired = true;
    queueMicrotask(() => {
      this._endEmitted = true;
      this.emit("end");
      if (this._autoDestroy) {
        this.destroy();
      }
    });
  }
  return this;
};

Readable.prototype.addListener = function addListener(
  evt: string | symbol,
  fn: (...args: unknown[]) => void,
): any {
  return this.on(evt, fn);
};

Readable.prototype.once = function once(
  evt: string | symbol,
  fn: (...args: unknown[]) => void,
): any {
  if (evt === "end" && this._endEmitted) {
    queueMicrotask(() => fn());
    return this;
  }
  if (evt === "end" && this._terminated && this._queue.length === 0 && !this._endFired) {
    this._endFired = true;
    EventEmitter.prototype.once.call(this, evt as string, fn);
    queueMicrotask(() => {
      this._endEmitted = true;
      this.emit("end");
      if (this._autoDestroy) {
        this.destroy();
      }
    });
    return this;
  }
  if (evt === "data" && !this._active) {
    EventEmitter.prototype.once.call(this, evt as string, fn);
    this.resume();
    return this;
  }
  return EventEmitter.prototype.once.call(this, evt as string, fn);
};

Readable.prototype.push = function push(chunk: any): boolean {
  if (chunk === null) {
    this._terminated = true;
    // Match Node: EOF is signaled but buffered data remains readable until drained.
    if (this._queue.length === 0) {
      this.readableEnded = true;
      this.readable = false;
      if (this._active && !this._endFired) {
        this._endFired = true;
        queueMicrotask(() => {
          this._endEmitted = true;
          this.emit("end");
        });
      }
    }
    if (this._active) {
      this._drain();
    }
    return false;
  }

  if (this._objectMode) {
    this._queue.push(chunk);
  } else {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this._readableByteLength += bufferByteLength(bytes);
    this._queue.push(bytes);
  }

  if (this._active) {
    this._drain();
  }
  return this._queue.length < this._highWaterMark;
};

Readable.prototype.unshift = function unshift(chunk: any): void {
  if (chunk === null) return;
  if (this._objectMode) {
    this._queue.unshift(chunk);
  } else {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this._readableByteLength += bufferByteLength(bytes);
    this._queue.unshift(bytes);
  }
};

Readable.prototype._drain = function _drain(): void {
  if (this._draining) return;
  this._draining = true;
  while (this._queue.length > 0 && this._active) {
    const item = this._queue.shift();
    if (!this._objectMode) {
      this._readableByteLength -= bufferByteLength(item);
    }
    this.readableDidRead = true;
    if (this._encoding && item instanceof Uint8Array) {
      this.emit("data", Buffer.from(item).toString(this._encoding));
    } else {
      this.emit("data", item);
    }
  }
  this._draining = false;
  if (this._terminated && this._queue.length === 0 && !this._endFired) {
    this.readableEnded = true;
    this.readable = false;
    this._endFired = true;
    queueMicrotask(() => {
      this._endEmitted = true;
      this.emit("end");
      if (this._autoDestroy) {
        this.destroy();
      }
    });
  }
  if (!this._terminated && this._queue.length === 0 && this._active && !this._reading) {
    this._reading = true;
    queueMicrotask(() => {
      this._reading = false;
      if (!this._terminated && this._active) {
        this._read(this._highWaterMark);
      }
    });
  }
};

Readable.prototype.read = function read(amount?: number): any {
  this.readableDidRead = true;
  if (!this._reading && !this._terminated) {
    this._reading = true;
    this._read(amount ?? this._highWaterMark);
    this._reading = false;
  }

  if (this._queue.length === 0) return null;

  if (this._objectMode) {
    const item = this._queue.shift();
    return item;
  }

  if (amount === undefined || amount === 0) {
    const combined = Buffer.concat(this._queue as Uint8Array[]);
    this._readableByteLength = 0;
    this._queue.length = 0;
    return combined;
  }

  const pieces: Uint8Array[] = [];
  let needed = amount;
  while (needed > 0 && this._queue.length > 0) {
    const front = this._queue[0] as Uint8Array;
    if (front.length <= needed) {
      pieces.push(this._queue.shift() as Uint8Array);
      this._readableByteLength -= front.length;
      needed -= front.length;
    } else {
      pieces.push(front.slice(0, needed));
      this._queue[0] = front.slice(needed);
      this._readableByteLength -= needed;
      needed = 0;
    }
  }
  return pieces.length > 0 ? Buffer.concat(pieces) : null;
};

Readable.prototype.resume = function resume(): any {
  this._active = true;
  this.readableFlowing = true;
  this._drain();
  if (!this._terminated && this._queue.length === 0 && !this._reading) {
    this._reading = true;
    queueMicrotask(() => {
      this._reading = false;
      if (!this._terminated && this._active) {
        this._read(this._highWaterMark);
      }
    });
  }
  return this;
};

Readable.prototype.pause = function pause(): any {
  this._active = false;
  this.readableFlowing = false;
  return this;
};

Readable.prototype.isPaused = function isPaused(): boolean {
  return !this._active;
};

Readable.prototype.pipe = function pipe(target: any): any {
  const self = this;
  self.on("data", function onData(chunk: unknown) {
    const needDrain = !target.write(chunk);
    if (needDrain) {
      self.pause();
      target.once("drain", function onDrain() { self.resume(); });
    }
  });
  self.on("end", function onEnd() {
    target.end();
  });
  self.resume();
  return target;
};

Readable.prototype.unpipe = function unpipe(_target?: any): any {
  this.removeAllListeners("data");
  this.removeAllListeners("end");
  return this;
};

Readable.prototype.setEncoding = function setEncoding(enc: string): any {
  this._encoding = enc as BufferEncoding;
  return this;
};

Readable.prototype.close = function close(cb?: (err?: Error | null) => void): void {
  this.destroy();
  if (cb) cb(null);
};

Readable.prototype.destroy = function destroy(fault?: Error): any {
  if (this.destroyed) return this;
  this.destroyed = true;
  if (fault) this.errored = fault;

  this._destroy(fault ?? null, (err: Error | null | undefined) => {
    if (err && !fault) this.errored = err;
    this._queue.length = 0;
    this._readableByteLength = 0;
    this._terminated = true;
    this.readable = false;
    if (err || fault) this.emit("error", err || fault);
    this.closed = true;
    this.emit("close");
  });
  return this;
};

Readable.prototype.wrap = function wrap(oldStream: any): any {
  const self = this;
  oldStream.on("data", function onData(chunk: unknown) {
    self.push(chunk);
  });
  oldStream.on("end", function onEnd() {
    self.push(null);
  });
  oldStream.on("error", function onError(err: unknown) {
    self.destroy(err as Error);
  });
  return this;
};

Readable.prototype[Symbol.asyncIterator] = function asyncIterator(): AsyncIterableIterator<unknown> {
  const stream = this;
  const buffer: unknown[] = [];
  let done = false;
  let error: Error | null = null;
  let waiting: ((val: IteratorResult<unknown>) => void) | null = null;
  let waitingReject: ((err: Error) => void) | null = null;

  const onData = (chunk: unknown) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      waitingReject = null;
      resolve({ value: chunk, done: false });
    } else {
      buffer.push(chunk);
    }
  };

  const onEnd = () => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      waitingReject = null;
      resolve({ value: undefined, done: true });
    }
    cleanup();
  };

  const onError = (...args: unknown[]) => {
    error = args[0] as Error;
    if (waitingReject) {
      const reject = waitingReject;
      waiting = null;
      waitingReject = null;
      reject(error);
    }
    cleanup();
  };

  const cleanup = () => {
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
    stream.removeListener("error", onError);
  };

  stream._rawBind("data", onData);
  stream._rawBind("end", onEnd);
  stream._rawBind("error", onError);
  if (!stream._active) stream.resume();

  return {
    next(): Promise<IteratorResult<unknown>> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift(), done: false });
      }
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve({ value: undefined, done: true });

      return new Promise<IteratorResult<unknown>>((resolve, reject) => {
        waiting = resolve;
        waitingReject = reject;
      });
    },
    return(): Promise<IteratorResult<unknown>> {
      cleanup();
      stream.destroy();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: Error): Promise<IteratorResult<unknown>> {
      cleanup();
      stream.destroy(err);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

Object.defineProperty(Readable.prototype, "readableLength", {
  get: function (this: any) {
    if (this._objectMode) return this._queue.length;
    return this._readableByteLength;
  },
  configurable: true,
});

Object.defineProperty(Readable.prototype, "readableEncoding", {
  get: function (this: any) {
    return this._encoding;
  },
  configurable: true,
});

Readable.toWeb = function toWeb(readable: any): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      readable.on("data", (chunk: unknown) => {
        const buf =
          chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
        controller.enqueue(buf);
      });
      readable.on("end", () => {
        controller.close();
      });
      readable.on("error", (err: unknown) => {
        controller.error(err);
      });
      readable.resume();
    },
    cancel() {
      readable.destroy();
    },
  });
};

Readable.fromWeb = function fromWeb(
  webStream: ReadableStream,
  opts?: { objectMode?: boolean; highWaterMark?: number },
): Readable {
  const reader = webStream.getReader();
  const stream = new Readable({
    ...opts,
    read() {
      reader.read().then(
        ({ value, done }: { value: any; done: boolean }) => {
          if (done) {
            stream.push(null);
          } else {
            stream.push(value);
          }
        },
        (err: Error) => {
          stream.destroy(err);
        },
      );
    },
  });
  return stream;
};

Readable.from = function from(
  source: Iterable<unknown> | AsyncIterable<unknown>,
  _opts?: { objectMode?: boolean; highWaterMark?: number },
): Readable {
  const stream = new Readable(_opts);
  (async () => {
    try {
      for await (const item of source as AsyncIterable<unknown>) {
        if (item !== null && item !== undefined) {
          const data = typeof item === "string" ? Buffer.from(item) : item;
          stream.push(data as Buffer);
        }
      }
      stream.push(null);
    } catch (err) {
      stream.destroy(err as Error);
    }
  })();
  return stream;
};

// Writable

export interface Writable extends EventEmitter {
  writable: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  writableNeedDrain: boolean;
  destroyed: boolean;
  closed: boolean;
  errored: Error | null;
  writableObjectMode: boolean;
  writableHighWaterMark: number;
  writableCorked: number;
  _writableState: any;
  _write(chunk: any, encoding: string, callback: (err?: Error | null) => void): void;
  _writev?(chunks: Array<{ chunk: any; encoding: string }>, callback: (err?: Error | null) => void): void;
  _final(callback: (err?: Error | null) => void): void;
  _destroy(err: Error | null, cb: (err?: Error | null) => void): void;
  readonly writableLength: number;
  write(chunk: any, encOrCb?: any, cb?: any): boolean;
  end(chunkOrCb?: any, encOrCb?: any, cb?: any): this;
  getBuffer(): Buffer;
  getBufferAsString(enc?: BufferEncoding): string;
  close(cb?: (err?: Error | null) => void): void;
  destroy(fault?: Error): this;
  cork(): void;
  uncork(): void;
  setDefaultEncoding(enc: string): this;
}

interface WritableConstructor {
  new (opts?: any): Writable;
  (this: any, opts?: any): void;
  prototype: any;
  toWeb(writable: Writable): WritableStream<Uint8Array>;
  fromWeb(webStream: WritableStream, opts?: any): Writable;
}

export const Writable = function Writable(this: any, opts?: any) {
  if (!this) return;
  EventEmitter.call(this);

  this._parts = [];
  this._closed = false;
  this._objectMode = false;
  this._highWaterMark = 16384;
  this._autoDestroy = true;
  this._corked = 0;
  this._corkedWrites = [];
  this._writableByteLength = 0;

  this.writable = true;
  this.writableEnded = false;
  this.writableFinished = false;
  this.writableNeedDrain = false;
  this.destroyed = false;
  this.closed = false;
  this.errored = null;
  this.writableObjectMode = false;
  this.writableHighWaterMark = 16384;
  this.writableCorked = 0;

  const self = this;
  this._writableState = {
    get objectMode() { return self._objectMode; },
    get highWaterMark() { return self._highWaterMark; },
    get finished() { return self.writableFinished; },
    set finished(v: boolean) { self.writableFinished = v; },
    get ended() { return self.writableEnded; },
    set ended(v: boolean) { self.writableEnded = v; },
    get destroyed() { return self.destroyed; },
    get errored() { return self.errored; },
    get closed() { return self.closed; },
    get corked() { return self._corked; },
    get length() { return self.writableLength; },
    get needDrain() { return self.writableNeedDrain; },
    writing: false,
    errorEmitted: false,
    emitClose: true,
    get autoDestroy() { return self._autoDestroy; },
    defaultEncoding: "utf8",
    finalCalled: false,
    ending: false,
    bufferedIndex: 0,
  };

  if (opts) {
    if (opts.objectMode) {
      this._objectMode = true;
      this.writableObjectMode = true;
      if (opts.highWaterMark === undefined) {
        this._highWaterMark = 16;
        this.writableHighWaterMark = 16;
      }
    }
    if (opts.highWaterMark !== undefined) {
      this._highWaterMark = opts.highWaterMark;
      this.writableHighWaterMark = opts.highWaterMark;
    }
    if (opts.autoDestroy !== undefined) {
      this._autoDestroy = opts.autoDestroy;
    }
    if (opts.write) {
      this._write = opts.write.bind(this);
    }
    if (opts.writev) {
      this._writev = opts.writev.bind(this);
    }
    if (opts.final) {
      this._final = opts.final.bind(this);
    }
    if (opts.destroy) {
      this._destroy = opts.destroy.bind(this);
    }
  }
} as unknown as WritableConstructor;

Object.setPrototypeOf(Writable.prototype, EventEmitter.prototype);

Writable.prototype._write = function _write(
  _chunk: any,
  _encoding: string,
  callback: (err?: Error | null) => void,
): void {
  callback(null);
};

Writable.prototype._final = function _final(
  callback: (err?: Error | null) => void,
): void {
  callback(null);
};

Writable.prototype._destroy = function _destroy(
  err: Error | null,
  callback: (err?: Error | null) => void,
): void {
  callback(err);
};

Writable.prototype.write = function write(
  chunk: any,
  encOrCb?: string | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  if (this._closed) {
    const fault = new Error("write after end");
    if (typeof encOrCb === "function") {
      encOrCb(fault);
    } else if (cb) {
      cb(fault);
    }
    return false;
  }

  const encoding = typeof encOrCb === "string" ? encOrCb : "utf8";
  const callback = typeof encOrCb === "function" ? encOrCb : cb;

  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  this._parts.push(bytes);
  this._writableByteLength += bufferByteLength(bytes);

  if (this._corked > 0) {
    this._corkedWrites.push({ chunk, encoding, callback });
    return this._writableByteLength < this._highWaterMark;
  }

  this._write(chunk, encoding, (err: Error | null | undefined) => {
    this._writableByteLength -= bufferByteLength(bytes);
    if (callback) callback(err);
    if (this.writableNeedDrain && this._writableByteLength < this._highWaterMark) {
      this.writableNeedDrain = false;
      this.emit("drain");
    }
  });

  const belowHWM = this._writableByteLength < this._highWaterMark;
  if (!belowHWM) {
    this.writableNeedDrain = true;
  }
  return belowHWM;
};

Writable.prototype.end = function end(
  chunkOrCb?: any,
  encOrCb?: any,
  cb?: () => void,
): any {
  if (typeof chunkOrCb === "function") {
    cb = chunkOrCb;
  } else if (chunkOrCb !== undefined) {
    this.write(chunkOrCb);
  }
  if (typeof encOrCb === "function") cb = encOrCb;

  this._closed = true;
  this.writable = false;
  this.writableEnded = true;

  const self = this;
  const doFinish = () => {
    self.writableFinished = true;
    self.emit("finish");
    if (self._autoDestroy) {
      self.closed = true;
      self.emit("close");
    }
    if (cb) cb();
  };

  queueMicrotask(() => {
    self._final((err: Error | null | undefined) => {
      if (err) {
        self.errored = err;
        self.emit("error", err);
        return;
      }
      doFinish();
    });
  });
  return this;
};

Writable.prototype.getBuffer = function getBuffer(): Buffer {
  return Buffer.concat(this._parts);
};

Writable.prototype.getBufferAsString = function getBufferAsString(enc?: BufferEncoding): string {
  return this.getBuffer().toString(enc || "utf8");
};

Writable.prototype.close = function close(cb?: (err?: Error | null) => void): void {
  this.destroy();
  if (cb) cb(null);
};

Writable.prototype.destroy = function destroy(fault?: Error): any {
  if (this.destroyed) return this;
  this.destroyed = true;
  if (fault) this.errored = fault;

  this._destroy(fault ?? null, (err: Error | null | undefined) => {
    if (err && !fault) this.errored = err;
    this._parts.length = 0;
    this._corkedWrites.length = 0;
    this._writableByteLength = 0;
    this._closed = true;
    this.writable = false;
    if (err || fault) this.emit("error", err || fault);
    this.closed = true;
    this.emit("close");
  });
  return this;
};

Writable.prototype.cork = function cork(): void {
  this._corked++;
  this.writableCorked = this._corked;
};

Writable.prototype.uncork = function uncork(): void {
  if (this._corked > 0) {
    this._corked--;
    this.writableCorked = this._corked;
  }
  if (this._corked === 0 && this._corkedWrites.length > 0) {
    const writes = this._corkedWrites.splice(0);
    if (this._writev) {
      this._writev(
        writes.map((w: any) => ({ chunk: w.chunk, encoding: w.encoding })),
        (err: Error | null | undefined) => {
          for (const w of writes) {
            if (w.callback) w.callback(err);
          }
        },
      );
    } else {
      for (const w of writes) {
        this._write(w.chunk, w.encoding, (err: Error | null | undefined) => {
          if (w.callback) w.callback(err);
        });
      }
    }
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(_enc: string): any {
  return this;
};

Object.defineProperty(Writable.prototype, "writableLength", {
  get: function (this: any) {
    if (this._objectMode) return this._parts.length;
    return this._writableByteLength;
  },
  configurable: true,
});

Writable.toWeb = function toWeb(writable: any): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ok = writable.write(chunk, (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
        if (ok) resolve();
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        writable.end(() => resolve());
      });
    },
    abort(reason) {
      writable.destroy(
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    },
  });
};

Writable.fromWeb = function fromWeb(
  webStream: WritableStream,
  opts?: { objectMode?: boolean; highWaterMark?: number },
): Writable {
  const writer = webStream.getWriter();
  return new Writable({
    ...opts,
    write(chunk: any, _encoding: string, callback: (err?: Error | null) => void) {
      writer.write(chunk).then(
        () => callback(null),
        (err: Error) => callback(err),
      );
    },
    final(callback: (err?: Error | null) => void) {
      writer.close().then(
        () => callback(null),
        (err: Error) => callback(err),
      );
    },
  });
};

// Duplex

export interface Duplex extends Readable {
  writable: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  writableNeedDrain: boolean;
  writableObjectMode: boolean;
  writableHighWaterMark: number;
  writableCorked: number;
  allowHalfOpen: boolean;
  _writableState: any;
  _write(chunk: any, encoding: string, callback: (err?: Error | null) => void): void;
  _writev?(chunks: Array<{ chunk: any; encoding: string }>, callback: (err?: Error | null) => void): void;
  _final(callback: (err?: Error | null) => void): void;
  readonly writableLength: number;
  write(chunk: any, encOrCb?: any, cb?: any): boolean;
  end(chunkOrCb?: any, encOrCb?: any, cb?: any): this;
  cork(): void;
  uncork(): void;
  setDefaultEncoding(enc: string): this;
}

interface DuplexConstructor {
  new (opts?: any): Duplex;
  (this: any, opts?: any): void;
  prototype: any;
  from(source: any, opts?: any): Duplex;
  toWeb(duplex: any): any;
  fromWeb(source: any, opts?: any): any;
}

export const Duplex = function Duplex(this: any, opts?: any) {
  if (!this) return;

  Readable.call(this, {
    objectMode: opts?.objectMode || opts?.readableObjectMode,
    highWaterMark: opts?.readableHighWaterMark ?? opts?.highWaterMark,
    autoDestroy: opts?.autoDestroy,
    read: opts?.read,
    destroy: opts?.destroy,
  });

  this._writeParts = [];
  this._writeClosed = false;
  this._writeObjectMode = false;
  this._writeHighWaterMark = 16384;
  this._writeAutoDestroy = true;
  this._duplexCorked = 0;
  this._duplexCorkedWrites = [];
  this._writableByteLen = 0;

  this.writable = true;
  this.writableEnded = false;
  this.writableFinished = false;
  this.writableNeedDrain = false;
  this.writableObjectMode = false;
  this.writableHighWaterMark = 16384;
  this.writableCorked = 0;
  this.allowHalfOpen = true;

  const self = this;
  this._writableState = {
    get objectMode() { return self._writeObjectMode; },
    get highWaterMark() { return self._writeHighWaterMark; },
    get finished() { return self.writableFinished; },
    set finished(v: boolean) { self.writableFinished = v; },
    get ended() { return self.writableEnded; },
    set ended(v: boolean) { self.writableEnded = v; },
    get destroyed() { return self.destroyed; },
    get errored() { return self.errored; },
    get closed() { return self.closed; },
    get corked() { return self._duplexCorked; },
    get length() { return self.writableLength; },
    get needDrain() { return self.writableNeedDrain; },
    writing: false,
    errorEmitted: false,
    emitClose: true,
    get autoDestroy() { return self._writeAutoDestroy; },
    defaultEncoding: "utf8",
    finalCalled: false,
    ending: false,
    bufferedIndex: 0,
  };

  if (opts) {
    if (opts.objectMode || opts.writableObjectMode) {
      this._writeObjectMode = true;
      this.writableObjectMode = true;
      if ((opts.writableHighWaterMark ?? opts.highWaterMark) === undefined) {
        this._writeHighWaterMark = 16;
        this.writableHighWaterMark = 16;
      }
    }
    if (opts.writableHighWaterMark !== undefined) {
      this._writeHighWaterMark = opts.writableHighWaterMark;
      this.writableHighWaterMark = opts.writableHighWaterMark;
    } else if (opts.highWaterMark !== undefined) {
      this._writeHighWaterMark = opts.highWaterMark;
      this.writableHighWaterMark = opts.highWaterMark;
    }
    if (opts.autoDestroy !== undefined) {
      this._writeAutoDestroy = opts.autoDestroy;
    }
    if (opts.allowHalfOpen !== undefined) {
      this.allowHalfOpen = opts.allowHalfOpen;
    }
    if (opts.write) {
      this._write = opts.write.bind(this);
    }
    if (opts.writev) {
      this._writev = opts.writev.bind(this);
    }
    if (opts.final) {
      this._final = opts.final.bind(this);
    }
  }
} as unknown as DuplexConstructor;

Object.setPrototypeOf(Duplex.prototype, Readable.prototype);

Duplex.prototype._write = function _write(
  _chunk: any,
  _encoding: string,
  callback: (err?: Error | null) => void,
): void {
  callback(null);
};

Duplex.prototype._final = function _final(
  callback: (err?: Error | null) => void,
): void {
  callback(null);
};

Duplex.prototype.write = function write(
  chunk: any,
  encOrCb?: string | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  if (this._writeClosed) return false;
  const encoding = typeof encOrCb === "string" ? encOrCb : "utf8";
  const callback = typeof encOrCb === "function" ? encOrCb : cb;
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  this._writeParts.push(bytes);
  this._writableByteLen += bufferByteLength(bytes);

  if (this._duplexCorked > 0) {
    this._duplexCorkedWrites.push({ chunk, encoding, callback });
    return this._writableByteLen < this._writeHighWaterMark;
  }

  this._write(chunk, encoding, (err: Error | null | undefined) => {
    this._writableByteLen -= bufferByteLength(bytes);
    if (callback) callback(err);
    if (this.writableNeedDrain && this._writableByteLen < this._writeHighWaterMark) {
      this.writableNeedDrain = false;
      this.emit("drain");
    }
  });

  const belowHWM = this._writableByteLen < this._writeHighWaterMark;
  if (!belowHWM) {
    this.writableNeedDrain = true;
  }
  return belowHWM;
};

Duplex.prototype.end = function end(
  chunkOrCb?: any,
  encOrCb?: any,
  cb?: () => void,
): any {
  if (typeof chunkOrCb === "function") {
    cb = chunkOrCb;
  } else if (chunkOrCb !== undefined) {
    this.write(chunkOrCb);
  }
  if (typeof encOrCb === "function") cb = encOrCb;

  this._writeClosed = true;
  this.writable = false;
  this.writableEnded = true;

  const self = this;
  const doFinish = () => {
    self.writableFinished = true;
    self.emit("finish");
    if (cb) cb();
  };

  queueMicrotask(() => {
    self._final((err: Error | null | undefined) => {
      if (err) {
        self.errored = err;
        self.emit("error", err);
        return;
      }
      doFinish();
    });
  });
  return this;
};

Duplex.prototype.cork = function cork(): void {
  this._duplexCorked++;
  this.writableCorked = this._duplexCorked;
};

Duplex.prototype.uncork = function uncork(): void {
  if (this._duplexCorked > 0) {
    this._duplexCorked--;
    this.writableCorked = this._duplexCorked;
  }
  if (this._duplexCorked === 0 && this._duplexCorkedWrites.length > 0) {
    const writes = this._duplexCorkedWrites.splice(0);
    if (this._writev) {
      this._writev(
        writes.map((w: any) => ({ chunk: w.chunk, encoding: w.encoding })),
        (err: Error | null | undefined) => {
          for (const w of writes) {
            if (w.callback) w.callback(err);
          }
        },
      );
    } else {
      for (const w of writes) {
        this._write(w.chunk, w.encoding, (err: Error | null | undefined) => {
          if (w.callback) w.callback(err);
        });
      }
    }
  }
};

Duplex.prototype.setDefaultEncoding = function setDefaultEncoding(_enc: string): any {
  return this;
};

Object.defineProperty(Duplex.prototype, "writableLength", {
  get: function (this: any) {
    if (this._writeObjectMode) return this._writeParts.length;
    return this._writableByteLen;
  },
  configurable: true,
});

Duplex.from = function from(
  source: any,
  _opts?: { objectMode?: boolean; highWaterMark?: number },
): Duplex {
  const duplex = new Duplex();
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { duplex.push(null); break; }
          duplex.push(value);
        }
      } catch (err) {
        duplex.destroy(err as Error);
      }
    })();
  } else {
    (async () => {
      try {
        for await (const item of source as AsyncIterable<unknown>) {
          if (item !== null && item !== undefined) {
            const data = typeof item === "string" ? Buffer.from(item) : item;
            duplex.push(data as Buffer);
          }
        }
        duplex.push(null);
      } catch (err) {
        duplex.destroy(err as Error);
      }
    })();
  }
  return duplex;
};

Duplex.toWeb = function toWeb(duplex: any): any {
  if (duplex instanceof Duplex) {
    const readable = Readable.toWeb(duplex);
    const writable = Writable.toWeb(duplex as any);
    return { readable, writable };
  }
  return Readable.toWeb(duplex);
};

Duplex.fromWeb = function fromWeb(
  source: any,
  _opts?: Record<string, unknown>,
): any {
  if (source instanceof ReadableStream) {
    return Readable.fromWeb(source, _opts as { objectMode?: boolean; highWaterMark?: number });
  }
  const pair = source;
  const duplex = new Duplex();
  const reader = pair.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { duplex.push(null); break; }
        duplex.push(value);
      }
    } catch (err) {
      duplex.destroy(err as Error);
    }
  })();
  return duplex;
};

// PassThrough

export interface PassThrough extends Duplex {}

interface PassThroughConstructor {
  new (opts?: any): PassThrough;
  (this: any, opts?: any): void;
  prototype: any;
}

export const PassThrough = function PassThrough(this: any, opts?: any) {
  if (!this) return;
  Duplex.call(this, opts);
} as unknown as PassThroughConstructor;

Object.setPrototypeOf(PassThrough.prototype, Duplex.prototype);

PassThrough.prototype.write = function write(
  chunk: any,
  encOrCb?: string | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  this.push(bytes);
  const callback = typeof encOrCb === "function" ? encOrCb : cb;
  if (callback) queueMicrotask(() => callback(null));
  return true;
};

// Transform

export interface Transform extends Duplex {
  _transform(chunk: any, encoding: string, done: (err?: Error | null, output?: any) => void): void;
  _flush(done: (err?: Error | null, output?: any) => void): void;
}

interface TransformConstructor {
  new (opts?: any): Transform;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Transform = function Transform(this: any, opts?: any) {
  if (!this) return;
  Duplex.call(this, opts);
  this._flushed = false;

  if (opts) {
    if (opts.transform) {
      this._transform = opts.transform.bind(this);
    }
    if (opts.flush) {
      this._flush = opts.flush.bind(this);
    }
  }
} as unknown as TransformConstructor;

Object.setPrototypeOf(Transform.prototype, Duplex.prototype);

Transform.prototype._transform = function _transform(
  chunk: any,
  _encoding: string,
  done: (err?: Error | null, output?: any) => void,
): void {
  done(null, chunk);
};

Transform.prototype._flush = function _flush(
  done: (err?: Error | null, output?: any) => void,
): void {
  done(null);
};

// flush remaining transform data before terminating the readable side
Transform.prototype._final = function _final(
  callback: (err?: Error | null) => void,
): void {
  const self = this;
  const finish = () => {
    callback(null);
    self.push(null);
  };
  if (self._flushed) {
    finish();
    return;
  }
  self._flushed = true;
  self._flush((err: Error | null | undefined, output: any) => {
    if (err) {
      callback(err);
      return;
    }
    if (output) self.push(output);
    finish();
  });
};

Transform.prototype.write = function write(
  chunk: any,
  encOrCb?: string | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const encoding = typeof encOrCb === "string" ? encOrCb : "utf8";
  const callback = typeof encOrCb === "function" ? encOrCb : cb;

  this._transform(bytes, encoding, (err: Error | null | undefined, output: any) => {
    if (err) {
      if (callback) callback(err);
      return;
    }
    if (output) this.push(output);
    if (callback) callback(null);
  });
  return true;
};

Transform.prototype.end = function end(
  chunkOrCb?: any,
  encOrCb?: any,
  cb?: () => void,
): any {
  // flush eagerly so data reaches the pipe destination before _final's microtask
  if (!this._flushed) {
    this._flushed = true;
    this._flush((_err: Error | null | undefined, output: any) => {
      if (output) this.push(output);
    });
  }
  return Duplex.prototype.end.call(this, chunkOrCb, encOrCb, cb);
};

// Stream (base class)

export interface Stream extends EventEmitter {
  pipe(dest: any): any;
}

interface StreamConstructor {
  new (): Stream;
  (this: any): void;
  prototype: any;
}

export const Stream = function Stream(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as StreamConstructor;

Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);

Stream.prototype.pipe = function pipe(dest: any): any {
  const src = this;
  const onData = (chunk: any) => {
    if (dest.write) dest.write(chunk);
  };
  src.on("data", onData);
  const onEnd = () => {
    if (dest.end) dest.end();
  };
  src.on("end", onEnd);
  // store for unpipe
  if (!src._pipeDests) src._pipeDests = [];
  src._pipeDests.push({ dest, onData, onEnd });
  return dest;
};

Stream.prototype.unpipe = function unpipe(dest?: any): any {
  const dests: Array<{ dest: any; onData: Function; onEnd: Function }> =
    this._pipeDests || [];
  if (dest) {
    const idx = dests.findIndex((d: any) => d.dest === dest);
    if (idx !== -1) {
      this.removeListener("data", dests[idx].onData as any);
      this.removeListener("end", dests[idx].onEnd as any);
      dests.splice(idx, 1);
    }
  } else {
    for (const d of dests) {
      this.removeListener("data", d.onData as any);
      this.removeListener("end", d.onEnd as any);
    }
    this._pipeDests = [];
  }
  return this;
};

export function addAbortSignal(
  signal: AbortSignal,
  stream: any,
): any {
  if (signal.aborted) {
    stream.destroy(new Error("The operation was aborted"));
  } else {
    const onAbort = () => {
      stream.destroy(new Error("The operation was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = (err?: Error) => {
      signal.removeEventListener("abort", onAbort);
      return origDestroy(err);
    };
  }
  return stream;
}

// require('stream') compatibility -- attach all types as static properties
const StreamAny = Stream as unknown as Record<string, unknown>;
StreamAny.Readable = Readable;
StreamAny.Writable = Writable;
StreamAny.Duplex = Duplex;
StreamAny.Transform = Transform;
StreamAny.PassThrough = PassThrough;
StreamAny.Stream = Stream;
StreamAny.from = Readable.from;
StreamAny.addAbortSignal = addAbortSignal;

export function pipeline(...args: unknown[]): unknown {
  const cb =
    typeof args[args.length - 1] === "function"
      ? (args.pop() as (err?: Error | null) => void)
      : null;

  const streams = args as any[];
  if (streams.length < 2) {
    if (cb)
      setTimeout(
        () => cb(new Error("pipeline requires at least 2 streams")),
        0,
      );
    return streams[0];
  }

  // web ReadableStreams (like fetch response.body) don't have .pipe(), wrap them
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    if (
      s &&
      typeof s.getReader === "function" &&
      typeof s.pipe !== "function" &&
      typeof s.on !== "function"
    ) {
      streams[i] = Readable.fromWeb(s);
    }
  }

  let errorOccurred = false;
  const onError = (...errArgs: unknown[]) => {
    const err = errArgs[0] as Error;
    if (errorOccurred) return;
    errorOccurred = true;
    for (const s of streams) {
      if (typeof s.destroy === "function") {
        s.destroy();
      }
    }
    if (cb) cb(err);
  };

  for (let i = 0; i < streams.length - 1; i++) {
    const src = streams[i];
    const dest = streams[i + 1];
    if (typeof src.pipe === "function") {
      src.pipe(dest);
    }
    src.on("error", onError);
  }

  const last = streams[streams.length - 1];
  last.on("error", onError);

  if (cb && !errorOccurred) {
    const onFinish = () => {
      if (!errorOccurred) cb(null);
    };
    if (last instanceof Readable) {
      last.on("end", onFinish);
    } else {
      last.on("finish", onFinish);
    }
  }

  return last;
}

export function finished(
  stream: unknown,
  optsOrCb?: { error?: boolean } | ((err?: Error) => void),
  cb?: (err?: Error) => void,
): () => void {
  const done = typeof optsOrCb === "function" ? optsOrCb : cb;
  const s = stream as any;
  let called = false;

  const onDone = (err?: Error) => {
    if (called) return;
    called = true;
    if (done) done(err);
  };

  const cleanup = () => {
    s.removeListener("end", onEnd);
    s.removeListener("finish", onFinish);
    s.removeListener("error", onErr);
    s.removeListener("close", onClose);
  };

  const onEnd = () => { cleanup(); onDone(); };
  const onFinish = () => { cleanup(); onDone(); };
  const onErr = (err: Error) => { cleanup(); onDone(err); };
  const onClose = () => { cleanup(); onDone(); };

  s.on("end", onEnd);
  s.on("finish", onFinish);
  s.on("error", onErr);
  s.on("close", onClose);

  if (s.readableEnded || s.writableFinished) {
    queueMicrotask(() => onDone());
  }

  return cleanup;
}

let _defaultHighWaterMark = 16384;
let _defaultObjectHighWaterMark = 16;

export function getDefaultHighWaterMark(objectMode?: boolean): number {
  return objectMode ? _defaultObjectHighWaterMark : _defaultHighWaterMark;
}

export function setDefaultHighWaterMark(objectMode: boolean, value: number): void {
  if (objectMode) {
    _defaultObjectHighWaterMark = value;
  } else {
    _defaultHighWaterMark = value;
  }
}

export const promises = {
  pipeline: async (...streams: unknown[]): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      pipeline(...streams, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  finished: async (
    stream: unknown,
    opts?: { error?: boolean },
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      finished(stream, opts, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
};

StreamAny.pipeline = pipeline;
StreamAny.finished = finished;
StreamAny.promises = promises;
StreamAny.getDefaultHighWaterMark = getDefaultHighWaterMark;
StreamAny.setDefaultHighWaterMark = setDefaultHighWaterMark;

export function compose(..._streams: unknown[]): Duplex {
  return new PassThrough() as unknown as Duplex;
}

export function isReadable(stream: unknown): boolean {
  if (!stream || typeof stream !== "object") return false;
  const s = stream as any;
  if (typeof s.read !== "function") return false;
  if (s.destroyed) return false;
  if (s.readableEnded || s._terminated) return false;
  return true;
}

export function isWritable(stream: unknown): boolean {
  if (!stream || typeof stream !== "object") return false;
  const s = stream as any;
  if (typeof s.write !== "function") return false;
  if (s.destroyed) return false;
  if (s.writableEnded || s.writableFinished) return false;
  return true;
}

export function isDisturbed(stream: unknown): boolean {
  if (!stream || typeof stream !== "object") return false;
  const s = stream as any;
  return !!s.readableDidRead || !!s._reading;
}

export function isErrored(stream: unknown): boolean {
  if (!stream || typeof stream !== "object") return false;
  const s = stream as any;
  return s.errored != null;
}

StreamAny.compose = compose;
StreamAny.isReadable = isReadable;
StreamAny.isWritable = isWritable;
StreamAny.isDisturbed = isDisturbed;
StreamAny.isErrored = isErrored;

(Readable as any).isDisturbed = isDisturbed;
(Readable as any).isReadable = isReadable;

export default Stream;
