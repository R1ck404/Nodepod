// Types for fs ReadStream/WriteStream. These are old-style function constructors
// (not classes) because graceful-fs uses .apply(this, arguments) which breaks classes.

import type { Writable } from "../polyfills/stream";

/* ---- ReadableState ---- */

export interface FsReadableState {
  readonly objectMode: boolean;
  readonly highWaterMark: number;
  readonly ended: boolean;
  endEmitted: boolean;
  flowing: boolean | null;
  readonly reading: boolean;
  readonly length: number;
  readonly destroyed: boolean;
  readonly errored: Error | null;
  readonly closed: boolean;
  pipes: unknown[];
  awaitDrainWriters: unknown;
  multiAwaitDrain: boolean;
  readableListening: boolean;
  resumeScheduled: boolean;
  paused: boolean;
  emitClose: boolean;
  readonly autoDestroy: boolean;
  defaultEncoding: string;
  needReadable: boolean;
  emittedReadable: boolean;
  readingMore: boolean;
  dataEmitted: boolean;
}

/* ---- WritableState ---- */

export interface FsWritableState {
  readonly objectMode: boolean;
  readonly highWaterMark: number;
  finished: boolean;
  ended: boolean;
  readonly destroyed: boolean;
  readonly errored: Error | null;
  readonly closed: boolean;
  readonly corked: number;
  readonly length: number;
  readonly needDrain: boolean;
  writing: boolean;
  errorEmitted: boolean;
  emitClose: boolean;
  readonly autoDestroy: boolean;
  defaultEncoding: string;
  finalCalled: boolean;
  ending: boolean;
  bufferedIndex: number;
}

/* ---- FsReadStream ---- */

export interface FsReadStreamInstance {
  _queue: Array<Buffer | null>;
  _active: boolean;
  _terminated: boolean;
  _endFired: boolean;
  _endEmitted: boolean;
  _objectMode: boolean;
  _reading: boolean;
  _highWaterMark: number;
  _autoDestroy: boolean;
  _encoding: string | null;
  _readableByteLength: number;
  _draining: boolean;

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

  _readableState: FsReadableState;

  path: string;
  fd: number | null;
  flags: string;
  mode: number;
  autoClose: boolean;

  open(): void;
  _read(): void;
  close(cb?: (err?: Error | null) => void): void;

  push(chunk: unknown): boolean;
  destroy(err?: unknown): void;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, fn: (...args: unknown[]) => void): this;
  pipe(dest: unknown): unknown;
}

/* ---- FsWriteStream ---- */

export interface FsWriteStreamOptions {
  encoding?: string;
  flags?: string | number;
  mode?: number;
  start?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  fd?: number;
  [key: string]: unknown;
}

export interface FsWriteStreamInstance extends Writable {
  _autoDestroy: boolean;
  _corked: number;

  _writableState: FsWritableState;

  path: string;
  fd: number | null;
  flags: string | number;
  mode: number;
  autoClose: boolean;
  bytesWritten: number;
  pos?: number;

  open(): void;
}
