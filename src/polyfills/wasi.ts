const ERRNO_SUCCESS = 0;
const ERRNO_2BIG = 1;
const ERRNO_ACCES = 2;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_IO = 29;
const ERRNO_ISDIR = 31;
const ERRNO_LOOP = 32;
const ERRNO_NOENT = 44;
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;
const ERRNO_NOTEMPTY = 55;
const ERRNO_NOTSUP = 58;
const ERRNO_OVERFLOW = 61;
const ERRNO_PERM = 63;
const ERRNO_PIPE = 64;
const ERRNO_ROFS = 69;
const ERRNO_SPIPE = 70;
const ERRNO_XDEV = 75;
const ERRNO_NOTCAPABLE = 76;

const CLOCKID_REALTIME = 0;
const CLOCKID_MONOTONIC = 1;
const CLOCKID_PROCESS_CPUTIME_ID = 2;
const CLOCKID_THREAD_CPUTIME_ID = 3;

const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;

const FDFLAGS_APPEND = 0x0001;
const FDFLAGS_DSYNC = 0x0002;
const FDFLAGS_NONBLOCK = 0x0004;
const FDFLAGS_RSYNC = 0x0008;
const FDFLAGS_SYNC = 0x0010;
const FDFLAGS_MASK = FDFLAGS_APPEND | FDFLAGS_DSYNC | FDFLAGS_NONBLOCK | FDFLAGS_RSYNC | FDFLAGS_SYNC;

const FSTFLAGS_ATIM = 0x0001;
const FSTFLAGS_ATIM_NOW = 0x0002;
const FSTFLAGS_MTIM = 0x0004;
const FSTFLAGS_MTIM_NOW = 0x0008;

const OFLAGS_CREAT = 0x0001;
const OFLAGS_DIRECTORY = 0x0002;
const OFLAGS_EXCL = 0x0004;
const OFLAGS_TRUNC = 0x0008;
const LOOKUPFLAGS_SYMLINK_FOLLOW = 0x0001;

const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

const PREOPENTYPE_DIR = 0;

const RIGHTS_FD_READ = 0x0000000000000002n;
const RIGHTS_FD_DATASYNC = 0x0000000000000001n;
const RIGHTS_FD_WRITE = 0x0000000000000040n;
const RIGHTS_FD_SEEK = 0x0000000000000004n;
const RIGHTS_FD_FDSTAT_SET_FLAGS = 0x0000000000000008n;
const RIGHTS_FD_SYNC = 0x0000000000000010n;
const RIGHTS_FD_TELL = 0x0000000000000020n;
const RIGHTS_FD_ADVISE = 0x0000000000000080n;
const RIGHTS_FD_ALLOCATE = 0x0000000000000100n;
const RIGHTS_FD_READDIR = 0x0000000000004000n;
const RIGHTS_PATH_OPEN = 0x0000000000002000n;
const RIGHTS_PATH_CREATE_DIRECTORY = 0x0000000000000200n;
const RIGHTS_PATH_CREATE_FILE = 0x0000000000000400n;
const RIGHTS_PATH_LINK_SOURCE = 0x0000000000000800n;
const RIGHTS_PATH_LINK_TARGET = 0x0000000000001000n;
const RIGHTS_PATH_UNLINK_FILE = 0x0000000004000000n;
const RIGHTS_PATH_REMOVE_DIRECTORY = 0x0000000002000000n;
const RIGHTS_PATH_RENAME_SOURCE = 0x0000000000010000n;
const RIGHTS_PATH_RENAME_TARGET = 0x0000000000020000n;
const RIGHTS_PATH_FILESTAT_GET = 0x0000000000040000n;
const RIGHTS_PATH_FILESTAT_SET_SIZE = 0x0000000000080000n;
const RIGHTS_PATH_FILESTAT_SET_TIMES = 0x0000000000100000n;
const RIGHTS_PATH_SYMLINK = 0x0000000001000000n;
const RIGHTS_PATH_READLINK = 0x0000000000008000n;
const RIGHTS_FD_FILESTAT_GET = 0x0000000000200000n;
const RIGHTS_FD_FILESTAT_SET_SIZE = 0x0000000000400000n;
const RIGHTS_FD_FILESTAT_SET_TIMES = 0x0000000000800000n;
const RIGHTS_POLL_FD_READWRITE = 0x0000000008000000n;

const RIGHTS_ALL = 0x3fffffffn;
const RIGHTS_DIR_BASE =
  RIGHTS_FD_READ |
  RIGHTS_FD_READDIR |
  RIGHTS_PATH_OPEN |
  RIGHTS_PATH_CREATE_DIRECTORY |
  RIGHTS_PATH_CREATE_FILE |
  RIGHTS_PATH_LINK_SOURCE |
  RIGHTS_PATH_LINK_TARGET |
  RIGHTS_PATH_UNLINK_FILE |
  RIGHTS_PATH_REMOVE_DIRECTORY |
  RIGHTS_PATH_RENAME_SOURCE |
  RIGHTS_PATH_RENAME_TARGET |
  RIGHTS_PATH_FILESTAT_GET |
  RIGHTS_PATH_FILESTAT_SET_SIZE |
  RIGHTS_PATH_FILESTAT_SET_TIMES |
  RIGHTS_PATH_SYMLINK |
  RIGHTS_PATH_READLINK |
  RIGHTS_FD_FILESTAT_GET |
  RIGHTS_FD_FILESTAT_SET_TIMES |
  RIGHTS_POLL_FD_READWRITE;
const RIGHTS_FILE_BASE =
  RIGHTS_FD_READ |
  RIGHTS_FD_WRITE |
  RIGHTS_FD_SEEK |
  RIGHTS_FD_TELL |
  RIGHTS_FD_DATASYNC |
  RIGHTS_FD_SYNC |
  RIGHTS_FD_ADVISE |
  RIGHTS_FD_ALLOCATE |
  RIGHTS_FD_FDSTAT_SET_FLAGS |
  RIGHTS_FD_FILESTAT_GET |
  RIGHTS_FD_FILESTAT_SET_SIZE |
  RIGHTS_FD_FILESTAT_SET_TIMES |
  RIGHTS_POLL_FD_READWRITE;

const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME = 0x0001;

/* ------------------------------------------------------------------ */
/*  Filesystem interface (subset of our MemoryVolume / fs bridge)     */
/* ------------------------------------------------------------------ */

interface WasiFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  ino?: number;
  nlink?: number;
}

interface WasiFS {
  readFileSync(p: string): Uint8Array;
  writeFileSync(p: string, data: string | Uint8Array): void;
  mkdirSync(p: string, options?: { recursive?: boolean }): void;
  statSync(p: string): WasiFileStat;
  lstatSync?(p: string): WasiFileStat;
  readdirSync(p: string): string[];
  unlinkSync(p: string): void;
  rmdirSync(p: string): void;
  renameSync(from: string, to: string): void;
  existsSync(p: string): boolean;
  symlinkSync?(target: string, linkPath: string): void;
  readlinkSync?(p: string): string;
  linkSync?(existingPath: string, newPath: string): void;
  truncateSync?(p: string, len?: number): void;
  utimesSync?(p: string, atime: number | Date, mtime: number | Date): void;
  readSync?(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync?(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): number;
  __openFileHandleSync?(p: string): {
    read(): Uint8Array;
    write(data: Uint8Array): void;
    stat(): { size: number; atimeMs: number; mtimeMs: number; ctimeMs: number; ino: number; nlink: number };
  };
  openFileHandleSync?: WasiFS["__openFileHandleSync"];
}

/* ------------------------------------------------------------------ */
/*  File descriptor table                                             */
/* ------------------------------------------------------------------ */

const enum FdKind {
  Stdin,
  Stdout,
  Stderr,
  PreopenDir,
  Directory,
  File,
}

interface FdEntry {
  kind: FdKind;
  path: string; // real path (for dirs and files)
  rights: bigint;
  inheritingRights?: bigint;
  // file-specific
  data?: Uint8Array;
  offset?: number;
  dirty?: boolean; // needs flush on close
  flags?: number; // O_APPEND etc
  unlinked?: boolean;
  hostFd?: number;
  handle?: ReturnType<NonNullable<WasiFS["__openFileHandleSync"]>>;
}

/* ------------------------------------------------------------------ */
/*  ExitStatus                                                         */
/* ---------------------------------------------------------------- */
export class ExitStatus extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`WASI exit(${code})`);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  syscall wrapper                                                    */
/* ---------------------------------------------------------------- */
let _wasiSyscallErrorLogged = false;
function syscall(target: Function): Function {
  return function (this: unknown, ...args: unknown[]): number {
    try {
      return target.apply(this, args);
    } catch (err: any) {
      if (err instanceof ExitStatus) throw err;
      if (err instanceof RangeError) return ERRNO_FAULT;
      // log the first syscall error to help debug WASM trap issues
      if (!_wasiSyscallErrorLogged && err?.message?.includes("Memory not available")) {
        _wasiSyscallErrorLogged = true;
        console.error("[WASI] Syscall failed — memory not available:", err.message);
        throw err; // don't swallow memory errors, they cause unreachable traps
      }
      const code = err?.code;
      const errno = ({
        EACCES: 2, EADDRINUSE: 3, EADDRNOTAVAIL: 4, EAFNOSUPPORT: 5,
        EAGAIN: 6, EWOULDBLOCK: 6, EALREADY: 7, EBADF: 8, EBADMSG: 9,
        EBUSY: 10, ECANCELED: 11, ECHILD: 12, ECONNABORTED: 13,
        ECONNREFUSED: 14, ECONNRESET: 15, EDEADLK: 16, EDESTADDRREQ: 17,
        EDOM: 18, EDQUOT: 19, EEXIST: 20, EFAULT: 21, EHOSTUNREACH: 23,
        EIDRM: 24, EILSEQ: 25, EINPROGRESS: 26, EINTR: 27, EINVAL: 28,
        EIO: 29, EISDIR: 31, ELOOP: 32, EMFILE: 33, EMLINK: 34,
        EMSGSIZE: 35, EMULTIHOP: 36, ENAMETOOLONG: 37, ENETDOWN: 38,
        ENETRESET: 39, ENETUNREACH: 40, ENFILE: 41, ENOBUFS: 42,
        ENODEV: 43, ENOENT: 44, ENOLCK: 45, ENOLINK: 47, ENOMEM: 48,
        ENOMSG: 49, ENOPROTOOPT: 50, ENOSPC: 51, ENOSYS: 52,
        ENOTCONN: 53, ENOTDIR: 54, ENOTEMPTY: 55, ENOTRECOVERABLE: 56,
        ENOTSOCK: 57, ENOTSUP: 58, EOPNOTSUPP: 58, ENOTTY: 59,
        ENXIO: 60, EOVERFLOW: 61, EOWNERDEAD: 62, EPERM: 63,
        EPIPE: 64, EPROTO: 65, EPROTONOSUPPORT: 66, EPROTOTYPE: 67,
        ERANGE: 68, EROFS: 69, ESPIPE: 70, ESRCH: 71, ESTALE: 72,
        ETIMEDOUT: 73, ETXTBSY: 74, EXDEV: 75, ENOTCAPABLE: 76,
      } as Record<string, number>)[code];
      if (errno !== undefined) return errno;
      if (!_wasiSyscallErrorLogged) {
        _wasiSyscallErrorLogged = true;
        console.error("[WASI] First syscall error:", err?.message || err, "code:", code);
      }
      return ERRNO_IO;
    }
  };
}

/*  Path helpers */

function pathError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) {
    throw pathError("ENOTCAPABLE", `absolute WASI path is outside the directory capability: ${rel}`);
  }
  const root = normalizePath(base);
  const rootParts = root.split("/").filter(Boolean);
  const out = [...rootParts];
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (out.length === rootParts.length) {
        throw pathError("ENOTCAPABLE", `WASI path escapes its directory capability: ${rel}`);
      }
      out.pop();
      continue;
    }
    if (seg.includes("\0")) throw pathError("EINVAL", "WASI paths cannot contain NUL bytes");
    out.push(seg);
  }
  return "/" + out.join("/");
}

function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/*  Text encoder / decoder (cached)*/
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// TextDecoder.decode() rejects SharedArrayBuffer views ("The provided ArrayBufferView value must not be shared.")
// threaded WASM (wasm32-wasip1-threads, emnapi) uses SharedArrayBuffer memory, so copy before decoding
const decodeFromMemory = (
  buffer: ArrayBufferLike,
  ptr: number,
  len: number,
): string => {
  if (len === 0) return "";
  const src = new Uint8Array(buffer, ptr, len);
  if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) {
    // copy into regular ArrayBuffer, TextDecoder accepts that
    const copy = new Uint8Array(len);
    copy.set(src);
    return decoder.decode(copy);
  }
  return decoder.decode(src);
};

/*  WASI class (matches Nodejs `wasi` module API) */

export interface WASIOptions {
  version: "preview1" | "unstable";
  args?: string[];
  env?: Record<string, string>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  stdin?: number;
  stdout?: number;
  stderr?: number;
  // extensions for our environment
  fs?: WasiFS;
}

export interface WASI {
  readonly wasiImport: Record<string, Function>;
  start(instance: object): number;
  initialize(instance: object): void;
  finalizeBindings(instance: object, options?: { memory?: WebAssembly.Memory }): void;
  getImportObject(): Record<string, Record<string, Function>>;
}

interface WASIConstructor {
  new (options: WASIOptions): WASI;
  (this: any, options: WASIOptions): void;
  prototype: any;
}

export const WASI = function WASI(this: any, options: WASIOptions) {
  if (!(this instanceof WASI)) {
    throw new TypeError(
      "Class constructor WASI cannot be invoked without 'new'",
    );
  }

  if (!options || typeof options.version !== "string") {
    throw new TypeError('The "options.version" property must be of type string');
  }
  if (options.version !== "preview1" && options.version !== "unstable") {
    throw new TypeError(`The property 'options.version' unsupported WASI version. Received '${options.version}'`);
  }
  const opts = options;
  const version = opts.version;
  const args = opts.args ?? [];
  const envVars = opts.env ?? {};
  const preopens = opts.preopens ?? {};
  const returnOnExit = opts.returnOnExit ?? true;
  const fs = opts.fs ?? null;
  for (const [name, value] of [["stdin", opts.stdin ?? 0], ["stdout", opts.stdout ?? 1], ["stderr", opts.stderr ?? 2]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`The "options.${name}" property must be a non-negative integer`);
  }

  /* file descriptor table */

  const fds = new Map<number, FdEntry>();
  let nextFd = 3;

  // fd 0 = stdin, fd 1 = stdout, fd 2 = stderr
  fds.set(0, { kind: FdKind.Stdin, path: "", rights: RIGHTS_FD_READ | RIGHTS_FD_FILESTAT_GET | RIGHTS_POLL_FD_READWRITE, hostFd: opts.stdin ?? 0 });
  fds.set(1, { kind: FdKind.Stdout, path: "", rights: RIGHTS_FD_WRITE | RIGHTS_FD_FILESTAT_GET | RIGHTS_POLL_FD_READWRITE, hostFd: opts.stdout ?? 1 });
  fds.set(2, { kind: FdKind.Stderr, path: "", rights: RIGHTS_FD_WRITE | RIGHTS_FD_FILESTAT_GET | RIGHTS_POLL_FD_READWRITE, hostFd: opts.stderr ?? 2 });

  // preopened directories
  const preopenEntries: Array<{
    fd: number;
    virtualPath: string;
    realPath: string;
  }> = [];
  for (const [virtualPath, realPath] of Object.entries(preopens)) {
    const fd = nextFd++;
    fds.set(fd, {
      kind: FdKind.PreopenDir,
      path: realPath,
      rights: RIGHTS_DIR_BASE,
      inheritingRights: RIGHTS_ALL,
    });
    preopenEntries.push({ fd, virtualPath, realPath });
  }

  /* wasm memory ref */

  let memory: WebAssembly.Memory | null = null;
  let instance: WebAssembly.Instance | null = null;
  let bindingsFinalized = false;

  const getMemory = (): WebAssembly.Memory => {
    if (memory) return memory;
    if (instance) {
      memory = (instance as any).exports?.memory as WebAssembly.Memory;
      if (memory) return memory;
    }
    // napi-rs imports memory instead of exporting it, must be set via initialize() or setMemory() before any syscall
    console.error("[WASI] Memory not available — initialize() may not have been called yet");
    throw new Error("WASI: WebAssembly.Memory not available — call initialize() or setMemory() first");
  };

  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);

  /* stdout / stderr text buffers */

  let stdoutBuf = "";
  let stderrBuf = "";
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  const flushLine = (fd: number, buf: string): string => {
    const nl = buf.lastIndexOf("\n");
    if (nl < 0) return buf;
    const lines = buf.substring(0, nl);
    if (fd === 1) console.log(lines);
    else console.error(lines);
    return buf.substring(nl + 1);
  };

  /* helpers */

  const readString = (ptr: number, len: number): string => {
    return decodeFromMemory(getMemory().buffer, ptr, len);
  };

  const writeString = (ptr: number, str: string): number => {
    const encoded = encoder.encode(str + "\0");
    bytes().set(encoded, ptr);
    return encoded.length;
  };

  const requireFd = (fd: number): FdEntry | number => fds.get(fd) ?? ERRNO_BADF;
  const requireRight = (entry: FdEntry, right: bigint): number =>
    (entry.rights & right) === right ? ERRNO_SUCCESS : ERRNO_NOTCAPABLE;
  const requireDirectory = (fd: number, right: bigint): FdEntry | number => {
    const entry = requireFd(fd);
    if (typeof entry === "number") return entry;
    if (entry.kind !== FdKind.PreopenDir && entry.kind !== FdKind.Directory) return ERRNO_NOTDIR;
    const allowed = requireRight(entry, right);
    return allowed === ERRNO_SUCCESS ? entry : allowed;
  };
  const requireExistingParent = (path: string): void => {
    if (!fs) return;
    const parent = normalizePath(path.slice(0, path.lastIndexOf("/")) || "/");
    const stat = fs.statSync(parent);
    if (!stat.isDirectory()) throw pathError("ENOTDIR", `not a directory: ${parent}`);
  };

  const resolveCapabilityPath = (
    directory: FdEntry,
    relativePath: string,
    followFinal = true,
    allowMissingFinal = false,
    depth = 0,
  ): string => {
    const root = normalizePath(directory.path);
    const lexical = joinPath(root, relativePath);
    if (!fs?.lstatSync || !fs.readlinkSync) return lexical;
    if (depth >= 40) throw pathError("ELOOP", `too many symbolic links: ${relativePath}`);
    const relative = lexical === root ? "" : lexical.slice(root.length + (root === "/" ? 0 : 1));
    const segments = relative.split("/").filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index++) {
      current = current === "/" ? `/${segments[index]}` : `${current}/${segments[index]}`;
      const isFinal = index === segments.length - 1;
      let stat: WasiFileStat;
      try {
        stat = fs.lstatSync(current);
      } catch (error: any) {
        if (allowMissingFinal && isFinal && error?.code === "ENOENT") return current;
        throw error;
      }
      if (!stat.isSymbolicLink() || (isFinal && !followFinal)) continue;
      const target = fs.readlinkSync(current);
      const parent = normalizePath(current.slice(0, current.lastIndexOf("/")) || "/");
      const resolvedTarget = target.startsWith("/")
        ? normalizePath(target)
        : normalizePath(`${parent}/${target}`);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(root === "/" ? "/" : root + "/")) {
        throw pathError("ENOTCAPABLE", `symbolic link escapes its directory capability: ${relativePath}`);
      }
      const remainder = segments.slice(index + 1).join("/");
      const next = remainder ? `${resolvedTarget}/${remainder}` : resolvedTarget;
      const nextRelative = root === "/" ? next.slice(1) : next.slice(root.length + 1);
      return resolveCapabilityPath(directory, nextRelative, followFinal, allowMissingFinal, depth + 1);
    }
    return lexical;
  };

  const flushFile = (entry: FdEntry): void => {
    if (entry.dirty && fs && entry.data && (entry.handle || (entry.path && !entry.unlinked))) {
      if (entry.handle) entry.handle.write(entry.data);
      else fs.writeFileSync(entry.path, entry.data);
      entry.dirty = false;
    }
  };

  const refreshFile = (entry: FdEntry): void => {
    if (!fs || entry.kind !== FdKind.File || entry.dirty) return;
    try {
      const data = entry.handle ? entry.handle.read() : fs.readFileSync(entry.path);
      const copy = new Uint8Array(data.length);
      copy.set(data);
      entry.data = copy;
    } catch (error: any) {
      if (error?.code === "ENOENT") entry.unlinked = true;
      else throw error;
    }
  };

  /* Build the wasi_snapshot_preview1 import object */
  const wasiImport: Record<string, Function> = {
    /* args */
    args_get: syscall((argv_ptr: number, argv_buf_ptr: number): number => {
      const dv = view();
      const mem = bytes();
      for (const arg of args) {
        dv.setUint32(argv_ptr, argv_buf_ptr, true);
        argv_ptr += 4;
        const encoded = encoder.encode(arg + "\0");
        mem.set(encoded, argv_buf_ptr);
        argv_buf_ptr += encoded.length;
      }
      return ERRNO_SUCCESS;
    }),

    args_sizes_get: syscall(
      (argc_out: number, argv_buf_size_out: number): number => {
        const dv = view();
        dv.setUint32(argc_out, args.length, true);
        let bufSize = 0;
        for (const arg of args) bufSize += encoder.encode(arg + "\0").length;
        dv.setUint32(argv_buf_size_out, bufSize, true);
        return ERRNO_SUCCESS;
      },
    ),

    /* environ */

    environ_get: syscall(
      (environ_ptr: number, environ_buf_ptr: number): number => {
        const entries = Object.entries(envVars);
        const dv = view();
        const mem = bytes();
        for (const [key, value] of entries) {
          dv.setUint32(environ_ptr, environ_buf_ptr, true);
          environ_ptr += 4;
          const encoded = encoder.encode(`${key}=${value}\0`);
          mem.set(encoded, environ_buf_ptr);
          environ_buf_ptr += encoded.length;
        }
        return ERRNO_SUCCESS;
      },
    ),

    environ_sizes_get: syscall(
      (environc_out: number, environ_buf_size_out: number): number => {
        const entries = Object.entries(envVars);
        const dv = view();
        dv.setUint32(environc_out, entries.length, true);
        let bufSize = 0;
        for (const [key, value] of entries)
          bufSize += encoder.encode(`${key}=${value}\0`).length;
        dv.setUint32(environ_buf_size_out, bufSize, true);
        return ERRNO_SUCCESS;
      },
    ),

    /* clock */

    clock_res_get: syscall((id: number, resolution_out: number): number => {
      const dv = view();
      switch (id) {
        case CLOCKID_REALTIME:
          dv.setBigUint64(resolution_out, 1n, true);
          break;
        case CLOCKID_MONOTONIC:
          dv.setBigUint64(resolution_out, 1n, true);
          break;
        case CLOCKID_PROCESS_CPUTIME_ID:
        case CLOCKID_THREAD_CPUTIME_ID:
          dv.setBigUint64(resolution_out, 100n, true);
          break;
        default:
          return ERRNO_INVAL;
      }
      return ERRNO_SUCCESS;
    }),

    clock_time_get: syscall(
      (id: number, _precision: bigint, time_out: number): number => {
        const dv = view();
        switch (id) {
          case CLOCKID_REALTIME: {
            const time = BigInt(Date.now()) * BigInt(1e6);
            dv.setBigUint64(time_out, time, true);
            break;
          }
          case CLOCKID_MONOTONIC: {
            const time = BigInt(Math.floor(performance.now() * 1e6));
            dv.setBigUint64(time_out, time, true);
            break;
          }
          case CLOCKID_PROCESS_CPUTIME_ID:
          case CLOCKID_THREAD_CPUTIME_ID:
            dv.setBigUint64(time_out, BigInt(Math.floor(performance.now() * 1e6)), true);
            break;
          default:
            return ERRNO_INVAL;
        }
        return ERRNO_SUCCESS;
      },
    ),

    /* ---- fd operations ------------------------------------------- */

    fd_advise: syscall(
      (fd: number, offset: bigint, len: bigint, advice: number): number => {
        const entry = fds.get(fd);
        if (!entry) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_ADVISE);
        if (allowed !== ERRNO_SUCCESS) return allowed;
        if (offset < 0n || len < 0n || advice < 0 || advice > 5) return ERRNO_INVAL;
        return ERRNO_SUCCESS; // advisory, can be a no-op
      },
    ),

    fd_allocate: syscall(
      (fd: number, offset: bigint, len: bigint): number => {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== FdKind.File) return ERRNO_BADF;
        refreshFile(entry);
        const allowed = requireRight(entry, RIGHTS_FD_ALLOCATE);
        if (allowed !== ERRNO_SUCCESS) return allowed;
        if (offset < 0n || len < 0n) return ERRNO_INVAL;
        const end = offset + len;
        if (end > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO_OVERFLOW;
        const size = Number(end);
        if (!entry.data || entry.data.length < size) {
          const data = new Uint8Array(size);
          if (entry.data) data.set(entry.data);
          entry.data = data;
          entry.dirty = true;
          flushFile(entry);
        }
        return ERRNO_SUCCESS;
      },
    ),

    fd_close: syscall((fd: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      if (entry.kind === FdKind.File) flushFile(entry);
      fds.delete(fd);
      return ERRNO_SUCCESS;
    }),

    fd_datasync: syscall((fd: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      if (entry.kind === FdKind.Stdin || entry.kind === FdKind.Stdout || entry.kind === FdKind.Stderr) return ERRNO_INVAL;
      const allowed = requireRight(entry, RIGHTS_FD_DATASYNC);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      if (entry.kind === FdKind.File) flushFile(entry);
      return ERRNO_SUCCESS;
    }),

    fd_fdstat_get: syscall((fd: number, stat_out: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      const dv = view();

      let filetype = FILETYPE_UNKNOWN;
      let fdflags = 0;
      let rightsBase = entry.rights;
      let rightsInheriting = 0n;

      switch (entry.kind) {
        case FdKind.Stdin:
        case FdKind.Stdout:
        case FdKind.Stderr:
          filetype = FILETYPE_CHARACTER_DEVICE;
          break;
        case FdKind.PreopenDir:
        case FdKind.Directory:
          filetype = FILETYPE_DIRECTORY;
          rightsInheriting = entry.inheritingRights ?? 0n;
          break;
        case FdKind.File:
          filetype = FILETYPE_REGULAR_FILE;
          if (entry.flags && entry.flags & FDFLAGS_APPEND)
            fdflags |= FDFLAGS_APPEND;
          break;
      }

      // fdstat layout: u8 filetype, u16 fdflags, u64 rights_base, u64 rights_inheriting
      dv.setUint8(stat_out, filetype);
      dv.setUint16(stat_out + 2, fdflags, true);
      dv.setBigUint64(stat_out + 8, rightsBase, true);
      dv.setBigUint64(stat_out + 16, rightsInheriting, true);
      return ERRNO_SUCCESS;
    }),

    fd_fdstat_set_flags: syscall((fd: number, flags: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      const allowed = requireRight(entry, RIGHTS_FD_FDSTAT_SET_FLAGS);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      if ((flags & ~FDFLAGS_MASK) !== 0) return ERRNO_INVAL;
      entry.flags = flags;
      return ERRNO_SUCCESS;
    }),

    fd_fdstat_set_rights: syscall(
      (
        fd: number,
        rights_base: bigint,
        rights_inheriting: bigint,
      ): number => {
        const entry = fds.get(fd);
        if (!entry) return ERRNO_BADF;
        if ((rights_base | entry.rights) !== entry.rights) return ERRNO_NOTCAPABLE;
        if (entry.kind !== FdKind.PreopenDir && entry.kind !== FdKind.Directory && rights_inheriting !== 0n) {
          return ERRNO_NOTCAPABLE;
        }
        const currentInheriting = entry.inheritingRights ?? 0n;
        if ((rights_inheriting | currentInheriting) !== currentInheriting) return ERRNO_NOTCAPABLE;
        entry.rights = rights_base;
        entry.inheritingRights = rights_inheriting;
        return ERRNO_SUCCESS;
      },
    ),

    fd_filestat_get: syscall((fd: number, buf_out: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      const allowed = requireRight(entry, RIGHTS_FD_FILESTAT_GET);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      if (entry.kind === FdKind.File) refreshFile(entry);

      const dv = view();
      let size = 0n;
      let filetype = FILETYPE_UNKNOWN;
      let mtimeNs = 0n;
      let atimeNs = 0n;
      let ctimeNs = 0n;
      let ino = 0n;
      let nlink = 1n;

      if (entry.kind === FdKind.File) {
        size = BigInt(entry.data ? entry.data.length : 0);
        filetype = FILETYPE_REGULAR_FILE;
        if (entry.handle) {
          const stat = entry.handle.stat();
          size = BigInt(stat.size);
          mtimeNs = BigInt(Math.floor(stat.mtimeMs)) * BigInt(1e6);
          atimeNs = BigInt(Math.floor(stat.atimeMs)) * BigInt(1e6);
          ctimeNs = BigInt(Math.floor(stat.ctimeMs)) * BigInt(1e6);
          ino = BigInt(stat.ino);
          nlink = BigInt(stat.nlink);
        } else if (fs && entry.path) {
          try {
            const stat = fs.statSync(entry.path);
            mtimeNs = BigInt(Math.floor(stat.mtimeMs)) * BigInt(1e6);
            atimeNs = BigInt(Math.floor(stat.atimeMs)) * BigInt(1e6);
            ctimeNs = BigInt(Math.floor(stat.ctimeMs)) * BigInt(1e6);
            if (stat.ino) ino = BigInt(stat.ino);
            if (stat.nlink) nlink = BigInt(stat.nlink);
          } catch {
            /* ignore */
          }
        }
      } else if (entry.kind === FdKind.PreopenDir || entry.kind === FdKind.Directory) {
        filetype = FILETYPE_DIRECTORY;
        // unique ino so walkdir with follow_links doesnt collapse opened dirs
        if (fs && entry.path) {
          try {
            const stat = fs.statSync(entry.path);
            if (stat.ino) ino = BigInt(stat.ino);
            if (stat.nlink) nlink = BigInt(stat.nlink);
          } catch {}
        }
      } else {
        filetype = FILETYPE_CHARACTER_DEVICE;
      }

      // filestat layout: u64 dev, u64 ino, u8 filetype (at +16), u64 nlink, u64 size,
      //                  u64 atim, u64 mtim, u64 ctim
      dv.setBigUint64(buf_out, 0n, true); // dev
      dv.setBigUint64(buf_out + 8, ino, true); // ino
      dv.setUint8(buf_out + 16, filetype); // filetype
      dv.setBigUint64(buf_out + 24, nlink, true); // nlink
      dv.setBigUint64(buf_out + 32, size, true); // size
      dv.setBigUint64(buf_out + 40, atimeNs, true);
      dv.setBigUint64(buf_out + 48, mtimeNs, true);
      dv.setBigUint64(buf_out + 56, ctimeNs, true);
      return ERRNO_SUCCESS;
    }),

    fd_filestat_set_size: syscall((fd: number, size: bigint): number => {
      const entry = fds.get(fd);
      if (!entry || entry.kind !== FdKind.File) return ERRNO_BADF;
      const allowed = requireRight(entry, RIGHTS_FD_FILESTAT_SET_SIZE);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      refreshFile(entry);
      if (size < 0n) return ERRNO_INVAL;
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO_OVERFLOW;
      const newSize = Number(size);
      if (!entry.data) {
        entry.data = new Uint8Array(newSize);
      } else if (entry.data.length !== newSize) {
        const newData = new Uint8Array(newSize);
        newData.set(
          entry.data.subarray(0, Math.min(entry.data.length, newSize)),
        );
        entry.data = newData;
      }
      entry.dirty = true;
      flushFile(entry);
      return ERRNO_SUCCESS;
    }),

    fd_filestat_set_times: syscall(
      (
        fd: number,
        atim: bigint,
        mtim: bigint,
        fst_flags: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry || !entry.path) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_FILESTAT_SET_TIMES);
        if (allowed !== ERRNO_SUCCESS) return allowed;
        if (!fs?.utimesSync) return ERRNO_NOTSUP;
        if ((fst_flags & ~(FSTFLAGS_ATIM | FSTFLAGS_ATIM_NOW | FSTFLAGS_MTIM | FSTFLAGS_MTIM_NOW)) !== 0) return ERRNO_INVAL;
        if ((fst_flags & FSTFLAGS_ATIM) && (fst_flags & FSTFLAGS_ATIM_NOW)) return ERRNO_INVAL;
        if ((fst_flags & FSTFLAGS_MTIM) && (fst_flags & FSTFLAGS_MTIM_NOW)) return ERRNO_INVAL;
        const stat = fs.statSync(entry.path);
        const now = Date.now();
        const atime = fst_flags & FSTFLAGS_ATIM_NOW ? now : fst_flags & FSTFLAGS_ATIM ? Number(atim / 1_000_000n) : stat.atimeMs;
        const mtime = fst_flags & FSTFLAGS_MTIM_NOW ? now : fst_flags & FSTFLAGS_MTIM ? Number(mtim / 1_000_000n) : stat.mtimeMs;
        fs.utimesSync(entry.path, atime / 1000, mtime / 1000);
        return ERRNO_SUCCESS;
      },
    ),

    fd_pread: syscall(
      (
        fd: number,
        iovs_ptr: number,
        iovs_len: number,
        offset: bigint,
        nread_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== FdKind.File) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_READ);
        if (allowed !== ERRNO_SUCCESS) return allowed;
        if (offset < 0n) return ERRNO_INVAL;
        if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO_OVERFLOW;
        refreshFile(entry);
        if (!entry.data) {
          view().setUint32(nread_out, 0, true);
          return ERRNO_SUCCESS;
        }

        const dv = view();
        let pos = Number(offset);
        let totalRead = 0;

        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
          const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
          const toRead = Math.min(bufLen, entry.data.length - pos);
          if (toRead <= 0) break;
          bytes().set(entry.data.subarray(pos, pos + toRead), bufPtr);
          pos += toRead;
          totalRead += toRead;
        }

        dv.setUint32(nread_out, totalRead, true);
        return ERRNO_SUCCESS;
      },
    ),

    fd_prestat_get: syscall((fd: number, buf_out: number): number => {
      const entry = fds.get(fd);
      if (!entry || entry.kind !== FdKind.PreopenDir) return ERRNO_BADF;

      const preopen = preopenEntries.find((p) => p.fd === fd);
      if (!preopen) return ERRNO_BADF;

      const dv = view();
      const nameLen = encoder.encode(preopen.virtualPath).length;
      // prestat: u8 type (0 = dir), then u32 name_len at +4
      dv.setUint8(buf_out, PREOPENTYPE_DIR);
      dv.setUint32(buf_out + 4, nameLen, true);
      return ERRNO_SUCCESS;
    }),

    fd_prestat_dir_name: syscall(
      (fd: number, path_ptr: number, path_len: number): number => {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== FdKind.PreopenDir) return ERRNO_BADF;

        const preopen = preopenEntries.find((p) => p.fd === fd);
        if (!preopen) return ERRNO_BADF;

        const encoded = encoder.encode(preopen.virtualPath);
        if (path_len < encoded.length) return 42; // NOBUFS
        bytes().set(encoded, path_ptr);
        return ERRNO_SUCCESS;
      },
    ),

    fd_pwrite: syscall(
      (
        fd: number,
        iovs_ptr: number,
        iovs_len: number,
        offset: bigint,
        nwritten_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== FdKind.File) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_WRITE);
        if (allowed !== ERRNO_SUCCESS) return allowed;
        if (offset < 0n) return ERRNO_INVAL;
        if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO_OVERFLOW;
        refreshFile(entry);

        const dv = view();
        let pos = Number(offset);
        let totalWritten = 0;

        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
          const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
          const chunk = new Uint8Array(getMemory().buffer, bufPtr, bufLen);

          // grow data if needed
          const needed = pos + bufLen;
          if (!entry.data || entry.data.length < needed) {
            const newData = new Uint8Array(needed);
            if (entry.data) newData.set(entry.data);
            entry.data = newData;
          }
          entry.data.set(chunk, pos);
          pos += bufLen;
          totalWritten += bufLen;
        }

        entry.dirty = true;
        flushFile(entry);
        dv.setUint32(nwritten_out, totalWritten, true);
        return ERRNO_SUCCESS;
      },
    ),

    fd_read: syscall(
      (
        fd: number,
        iovs_ptr: number,
        iovs_len: number,
        nread_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_READ);
        if (allowed !== ERRNO_SUCCESS) return allowed;

        const dv = view();

        if (entry.kind === FdKind.Stdin) {
          let totalRead = 0;
          if (entry.hostFd !== 0 && fs?.readSync) {
            for (let i = 0; i < iovs_len; i++) {
              const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
              const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
              const destination = new Uint8Array(getMemory().buffer, bufPtr, bufLen);
              const copy = new Uint8Array(bufLen);
              const count = fs.readSync(entry.hostFd!, copy, 0, bufLen, null);
              destination.set(copy.subarray(0, count));
              totalRead += count;
              if (count < bufLen) break;
            }
          }
          dv.setUint32(nread_out, totalRead, true);
          return ERRNO_SUCCESS;
        }

        if (entry.kind !== FdKind.File) return ERRNO_BADF;
        refreshFile(entry);
        if (!entry.data) {
          dv.setUint32(nread_out, 0, true);
          return ERRNO_SUCCESS;
        }

        let totalRead = 0;
        let pos = entry.offset ?? 0;

        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
          const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
          const toRead = Math.min(bufLen, entry.data.length - pos);
          if (toRead <= 0) break;
          bytes().set(entry.data.subarray(pos, pos + toRead), bufPtr);
          pos += toRead;
          totalRead += toRead;
        }

        entry.offset = pos;
        dv.setUint32(nread_out, totalRead, true);
        return ERRNO_SUCCESS;
      },
    ),

    fd_readdir: syscall(
      (
        fd: number,
        buf_ptr: number,
        buf_len: number,
        cookie: bigint,
        bufused_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (
          !entry ||
          (entry.kind !== FdKind.PreopenDir && entry.kind !== FdKind.Directory)
        )
          return ERRNO_BADF;
        if (!fs) return ERRNO_NOSYS;
        const allowed = requireRight(entry, RIGHTS_FD_READDIR);
        if (allowed !== ERRNO_SUCCESS) return allowed;

        let entries: string[];
        try {
          entries = [".", "..", ...fs.readdirSync(entry.path)];
        } catch {
          return ERRNO_IO;
        }

        const dv = view();
        const mem = bytes();
        let offset = buf_ptr;
        const end = buf_ptr + buf_len;
        const start = Number(cookie);

        for (let i = start; i < entries.length; i++) {
          const name = entries[i];
          const nameBytes = encoder.encode(name);

          const record = new Uint8Array(24 + nameBytes.length);
          const recordView = new DataView(record.buffer);
          recordView.setBigUint64(0, BigInt(i + 1), true);
          let dtype = FILETYPE_REGULAR_FILE;
          let dino = BigInt(i + 1);
          try {
            const childPath = name === "."
              ? entry.path
              : name === ".."
                ? normalizePath(entry.path + "/..")
                : joinPath(entry.path, name);
            const st = fs.statSync(childPath);
            if (st.isDirectory()) dtype = FILETYPE_DIRECTORY;
            else if (st.isSymbolicLink()) dtype = FILETYPE_SYMBOLIC_LINK;
            if (st.ino) dino = BigInt(st.ino);
          } catch {}
          recordView.setBigUint64(8, dino, true);
          recordView.setUint32(16, nameBytes.length, true);
          recordView.setUint8(20, dtype);
          record.set(nameBytes, 24);
          const copyLength = Math.min(record.length, end - offset);
          if (copyLength <= 0) break;
          mem.set(record.subarray(0, copyLength), offset);
          offset += copyLength;
          if (copyLength < record.length) break;
        }

        dv.setUint32(bufused_out, offset - buf_ptr, true);
        return ERRNO_SUCCESS;
      },
    ),

    fd_renumber: syscall((fd: number, to: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      if (fd === to) return ERRNO_SUCCESS;
      if (fds.has(to)) {
        const toEntry = fds.get(to)!;
        if (toEntry.kind === FdKind.File) flushFile(toEntry);
      }
      fds.set(to, entry);
      fds.delete(fd);
      return ERRNO_SUCCESS;
    }),

    fd_seek: syscall(
      (
        fd: number,
        offset: bigint,
        whence: number,
        newoffset_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_SEEK);
        if (allowed !== ERRNO_SUCCESS) return allowed;

        if (
          entry.kind === FdKind.Stdin ||
          entry.kind === FdKind.Stdout ||
          entry.kind === FdKind.Stderr
        ) {
          return ERRNO_SPIPE;
        }
        if (entry.kind === FdKind.PreopenDir || entry.kind === FdKind.Directory) return ERRNO_BADF;
        refreshFile(entry);

        const dataLen = entry.data ? entry.data.length : 0;
        let pos = entry.offset ?? 0;
        const off = Number(offset);

        switch (whence) {
          case WHENCE_SET:
            pos = off;
            break;
          case WHENCE_CUR:
            pos += off;
            break;
          case WHENCE_END:
            pos = dataLen + off;
            break;
          default:
            return ERRNO_INVAL;
        }

        if (!Number.isSafeInteger(pos) || pos < 0) return pos < 0 ? ERRNO_INVAL : ERRNO_OVERFLOW;
        entry.offset = pos;
        view().setBigUint64(newoffset_out, BigInt(pos), true);
        return ERRNO_SUCCESS;
      },
    ),

    fd_sync: syscall((fd: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      if (entry.kind === FdKind.Stdin || entry.kind === FdKind.Stdout || entry.kind === FdKind.Stderr) return ERRNO_INVAL;
      const allowed = requireRight(entry, RIGHTS_FD_SYNC);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      if (entry.kind === FdKind.File) flushFile(entry);
      return ERRNO_SUCCESS;
    }),

    fd_tell: syscall((fd: number, offset_out: number): number => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO_BADF;
      const allowed = requireRight(entry, RIGHTS_FD_TELL);
      if (allowed !== ERRNO_SUCCESS) return allowed;
      if (entry.kind !== FdKind.File) return ERRNO_SPIPE;
      view().setBigUint64(offset_out, BigInt(entry.offset ?? 0), true);
      return ERRNO_SUCCESS;
    }),

    fd_write: syscall(
      (
        fd: number,
        iovs_ptr: number,
        iovs_len: number,
        nwritten_out: number,
      ): number => {
        const entry = fds.get(fd);
        if (!entry) return ERRNO_BADF;
        const allowed = requireRight(entry, RIGHTS_FD_WRITE);
        if (allowed !== ERRNO_SUCCESS) return allowed;

        const dv = view();

        // stdout / stderr
        if (entry.kind === FdKind.Stdout || entry.kind === FdKind.Stderr) {
          let totalWritten = 0;
          for (let i = 0; i < iovs_len; i++) {
            const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
            const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
            const source = new Uint8Array(getMemory().buffer, bufPtr, bufLen);
            const chunk = new Uint8Array(bufLen);
            chunk.set(source);
            if (entry.hostFd !== (entry.kind === FdKind.Stdout ? 1 : 2) && fs?.writeSync) {
              totalWritten += fs.writeSync(entry.hostFd!, chunk, 0, chunk.length, null);
              continue;
            }
            const text = (entry.kind === FdKind.Stdout ? stdoutDecoder : stderrDecoder).decode(chunk, { stream: true });
            if (entry.kind === FdKind.Stdout) {
              stdoutBuf += text;
              stdoutBuf = flushLine(1, stdoutBuf);
            } else {
              stderrBuf += text;
              stderrBuf = flushLine(2, stderrBuf);
            }
            totalWritten += bufLen;
          }
          dv.setUint32(nwritten_out, totalWritten, true);
          return ERRNO_SUCCESS;
        }

        if (entry.kind !== FdKind.File) return ERRNO_BADF;
        refreshFile(entry);

        let totalWritten = 0;
        let pos =
          entry.flags && entry.flags & FDFLAGS_APPEND
            ? entry.data
              ? entry.data.length
              : 0
            : (entry.offset ?? 0);

        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = dv.getUint32(iovs_ptr + i * 8, true);
          const bufLen = dv.getUint32(iovs_ptr + i * 8 + 4, true);
          const chunk = new Uint8Array(getMemory().buffer, bufPtr, bufLen);

          const needed = pos + bufLen;
          if (!entry.data || entry.data.length < needed) {
            const newData = new Uint8Array(needed);
            if (entry.data) newData.set(entry.data);
            entry.data = newData;
          }
          entry.data.set(chunk, pos);
          pos += bufLen;
          totalWritten += bufLen;
        }

        entry.offset = pos;
        entry.dirty = true;
        flushFile(entry);
        dv.setUint32(nwritten_out, totalWritten, true);
        return ERRNO_SUCCESS;
      },
    ),

    /* path operations */

    path_create_directory: syscall(
      (fd: number, path_ptr: number, path_len: number): number => {
        if (!fs) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_CREATE_DIRECTORY);
        if (typeof entry === "number") return entry;
        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(entry, rel, false, true);
        fs.mkdirSync(fullPath);
        return ERRNO_SUCCESS;
      },
    ),

    path_filestat_get: syscall(
      (
        fd: number,
        flags: number,
        path_ptr: number,
        path_len: number,
        buf_out: number,
      ): number => {
        if (!fs) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_FILESTAT_GET);
        if (typeof entry === "number") return entry;
        if ((flags & ~LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0) return ERRNO_INVAL;
        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(entry, rel, (flags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0);

        const stat = flags & LOOKUPFLAGS_SYMLINK_FOLLOW || !fs.lstatSync
          ? fs.statSync(fullPath)
          : fs.lstatSync(fullPath);
        const dv = view();

        let filetype = FILETYPE_REGULAR_FILE;
        if (stat.isDirectory()) filetype = FILETYPE_DIRECTORY;
        else if (stat.isSymbolicLink()) filetype = FILETYPE_SYMBOLIC_LINK;

        const mtimeNs = BigInt(Math.floor(stat.mtimeMs)) * BigInt(1e6);
        const atimeNs = BigInt(Math.floor(stat.atimeMs)) * BigInt(1e6);
        const ctimeNs = BigInt(Math.floor(stat.ctimeMs)) * BigInt(1e6);

        dv.setBigUint64(buf_out, 0n, true); // dev
        dv.setBigUint64(buf_out + 8, BigInt(stat.ino ?? 0), true); // ino
        dv.setUint8(buf_out + 16, filetype); // filetype
        dv.setBigUint64(buf_out + 24, BigInt(stat.nlink ?? 1), true);
        dv.setBigUint64(buf_out + 32, BigInt(stat.size), true);
        dv.setBigUint64(buf_out + 40, atimeNs, true);
        dv.setBigUint64(buf_out + 48, mtimeNs, true);
        dv.setBigUint64(buf_out + 56, ctimeNs, true);
        return ERRNO_SUCCESS;
      },
    ),

    path_filestat_set_times: syscall(
      (
        fd: number,
        flags: number,
        path_ptr: number,
        path_len: number,
        atim: bigint,
        mtim: bigint,
        fst_flags: number,
      ): number => {
        if (!fs?.utimesSync) return ERRNO_NOTSUP;
        const entry = requireDirectory(fd, RIGHTS_PATH_FILESTAT_SET_TIMES);
        if (typeof entry === "number") return entry;
        if ((flags & ~LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0) return ERRNO_INVAL;
        if ((fst_flags & ~(FSTFLAGS_ATIM | FSTFLAGS_ATIM_NOW | FSTFLAGS_MTIM | FSTFLAGS_MTIM_NOW)) !== 0) return ERRNO_INVAL;
        if ((fst_flags & FSTFLAGS_ATIM) && (fst_flags & FSTFLAGS_ATIM_NOW)) return ERRNO_INVAL;
        if ((fst_flags & FSTFLAGS_MTIM) && (fst_flags & FSTFLAGS_MTIM_NOW)) return ERRNO_INVAL;
        const fullPath = resolveCapabilityPath(
          entry,
          readString(path_ptr, path_len),
          (flags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0,
        );
        const stat = fs.statSync(fullPath);
        const now = Date.now();
        const atime = fst_flags & FSTFLAGS_ATIM_NOW ? now : fst_flags & FSTFLAGS_ATIM ? Number(atim / 1_000_000n) : stat.atimeMs;
        const mtime = fst_flags & FSTFLAGS_MTIM_NOW ? now : fst_flags & FSTFLAGS_MTIM ? Number(mtim / 1_000_000n) : stat.mtimeMs;
        fs.utimesSync(fullPath, atime / 1000, mtime / 1000);
        return ERRNO_SUCCESS;
      },
    ),

    path_link: syscall(
      (
        old_fd: number,
        old_flags: number,
        old_path_ptr: number,
        old_path_len: number,
        new_fd: number,
        new_path_ptr: number,
        new_path_len: number,
      ): number => {
        if (!fs?.linkSync) return ERRNO_NOTSUP;
        if ((old_flags & ~LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0) return ERRNO_INVAL;
        const oldEntry = requireDirectory(old_fd, RIGHTS_PATH_LINK_SOURCE);
        const newEntry = requireDirectory(new_fd, RIGHTS_PATH_LINK_TARGET);
        if (typeof oldEntry === "number") return oldEntry;
        if (typeof newEntry === "number") return newEntry;
        const oldPath = resolveCapabilityPath(
          oldEntry,
          readString(old_path_ptr, old_path_len),
          (old_flags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0,
        );
        const newPath = resolveCapabilityPath(
          newEntry,
          readString(new_path_ptr, new_path_len),
          false,
          true,
        );
        requireExistingParent(newPath);
        fs.linkSync(oldPath, newPath);
        return ERRNO_SUCCESS;
      },
    ),

    path_open: syscall(
      (
        fd: number,
        dirflags: number,
        path_ptr: number,
        path_len: number,
        oflags: number,
        fs_rights_base: bigint,
        fs_rights_inheriting: bigint,
        fdflags: number,
        opened_fd_out: number,
      ): number => {
        if (!fs) return ERRNO_NOSYS;
        const dirEntry = requireDirectory(fd, RIGHTS_PATH_OPEN);
        if (typeof dirEntry === "number") return dirEntry;
        if ((dirflags & ~LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0) return ERRNO_INVAL;
        if ((oflags & ~(OFLAGS_CREAT | OFLAGS_DIRECTORY | OFLAGS_EXCL | OFLAGS_TRUNC)) !== 0) return ERRNO_INVAL;
        if ((fdflags & ~FDFLAGS_MASK) !== 0) return ERRNO_INVAL;
        const inheriting = dirEntry.inheritingRights ?? 0n;
        if ((fs_rights_base | inheriting) !== inheriting || (fs_rights_inheriting | inheriting) !== inheriting) {
          return ERRNO_NOTCAPABLE;
        }

        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(
          dirEntry,
          rel,
          (dirflags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0,
          (oflags & OFLAGS_CREAT) !== 0,
        );

        const wantDir = (oflags & OFLAGS_DIRECTORY) !== 0;
        const wantCreate = (oflags & OFLAGS_CREAT) !== 0;
        const wantExcl = (oflags & OFLAGS_EXCL) !== 0;
        const wantTrunc = (oflags & OFLAGS_TRUNC) !== 0;

        let exists = fs.existsSync(fullPath);
        if (exists && fs.lstatSync?.(fullPath).isSymbolicLink() && !(dirflags & LOOKUPFLAGS_SYMLINK_FOLLOW)) {
          return ERRNO_LOOP;
        }
        if (wantExcl && exists) return ERRNO_EXIST;
        if (wantCreate && requireRight(dirEntry, RIGHTS_PATH_CREATE_FILE) !== ERRNO_SUCCESS) return ERRNO_NOTCAPABLE;
        if (wantTrunc && requireRight(dirEntry, RIGHTS_PATH_FILESTAT_SET_SIZE) !== ERRNO_SUCCESS) return ERRNO_NOTCAPABLE;
        if (!exists && wantCreate) requireExistingParent(fullPath);

        if (wantDir) {
          if (!exists) {
            if (wantCreate) {
              fs.mkdirSync(fullPath);
            } else {
              return ERRNO_NOENT;
            }
          }
          if (!fs.statSync(fullPath).isDirectory()) return ERRNO_NOTDIR;
          // open directory fd
          const newFd = nextFd++;
          fds.set(newFd, {
            kind: FdKind.Directory,
            path: fullPath,
            rights: fs_rights_base,
            inheritingRights: fs_rights_inheriting,
          });
          view().setUint32(opened_fd_out, newFd, true);
          return ERRNO_SUCCESS;
        }

        if (exists && fs.statSync(fullPath).isDirectory()) return ERRNO_ISDIR;

        // regular file
        let data: Uint8Array;
        if (exists && !wantTrunc) {
          data = fs.readFileSync(fullPath);
          // make a copy so mutations dont affect the volume until flush
          const copy = new Uint8Array(data.length);
          copy.set(data);
          data = copy;
        } else if (wantCreate || wantTrunc) {
          if (!exists) {
            fs.writeFileSync(fullPath, new Uint8Array(0));
          } else if (wantTrunc) {
            if (fs.truncateSync) fs.truncateSync(fullPath, 0);
            else fs.writeFileSync(fullPath, new Uint8Array(0));
          }
          data = new Uint8Array(0);
        } else {
          if (!exists) return ERRNO_NOENT;
          data = fs.readFileSync(fullPath);
          const copy = new Uint8Array(data.length);
          copy.set(data);
          data = copy;
        }

        const newFd = nextFd++;
        const openHandle = fs.__openFileHandleSync ?? fs.openFileHandleSync;
        const handle = openHandle?.call(fs, fullPath);
        fds.set(newFd, {
          kind: FdKind.File,
          path: fullPath,
          rights: fs_rights_base,
          inheritingRights: 0n,
          data,
          offset: 0,
          dirty: false,
          flags: fdflags,
          handle,
        });
        view().setUint32(opened_fd_out, newFd, true);
        return ERRNO_SUCCESS;
      },
    ),

    path_readlink: syscall(
      (
        fd: number,
        path_ptr: number,
        path_len: number,
        buf_ptr: number,
        buf_len: number,
        bufused_out: number,
      ): number => {
        if (!fs || !fs.readlinkSync) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_READLINK);
        if (typeof entry === "number") return entry;
        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(entry, rel, false);
        const target = fs.readlinkSync(fullPath);
        const encoded = encoder.encode(target);
        const toCopy = Math.min(encoded.length, buf_len);
        bytes().set(encoded.subarray(0, toCopy), buf_ptr);
        view().setUint32(bufused_out, toCopy, true);
        return ERRNO_SUCCESS;
      },
    ),

    path_remove_directory: syscall(
      (fd: number, path_ptr: number, path_len: number): number => {
        if (!fs) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_REMOVE_DIRECTORY);
        if (typeof entry === "number") return entry;
        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(entry, rel, false);
        fs.rmdirSync(fullPath);
        return ERRNO_SUCCESS;
      },
    ),

    path_rename: syscall(
      (
        fd: number,
        old_path_ptr: number,
        old_path_len: number,
        new_fd: number,
        new_path_ptr: number,
        new_path_len: number,
      ): number => {
        if (!fs) return ERRNO_NOSYS;
        const oldEntry = requireDirectory(fd, RIGHTS_PATH_RENAME_SOURCE);
        const newEntry = requireDirectory(new_fd, RIGHTS_PATH_RENAME_TARGET);
        if (typeof oldEntry === "number") return oldEntry;
        if (typeof newEntry === "number") return newEntry;
        const oldRel = readString(old_path_ptr, old_path_len);
        const newRel = readString(new_path_ptr, new_path_len);
        const oldPath = resolveCapabilityPath(oldEntry, oldRel, false);
        const newPath = resolveCapabilityPath(newEntry, newRel, false, true);
        requireExistingParent(newPath);
        fs.renameSync(oldPath, newPath);
        for (const open of fds.values()) {
          if (open.path === oldPath || open.path.startsWith(oldPath + "/")) {
            open.path = newPath + open.path.slice(oldPath.length);
          }
        }
        return ERRNO_SUCCESS;
      },
    ),

    path_symlink: syscall(
      (
        old_path_ptr: number,
        old_path_len: number,
        fd: number,
        new_path_ptr: number,
        new_path_len: number,
      ): number => {
        if (!fs || !fs.symlinkSync) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_SYMLINK);
        if (typeof entry === "number") return entry;
        const target = readString(old_path_ptr, old_path_len);
        const linkRel = readString(new_path_ptr, new_path_len);
        const linkPath = resolveCapabilityPath(entry, linkRel, false, true);
        requireExistingParent(linkPath);
        fs.symlinkSync(target, linkPath);
        return ERRNO_SUCCESS;
      },
    ),

    path_unlink_file: syscall(
      (fd: number, path_ptr: number, path_len: number): number => {
        if (!fs) return ERRNO_NOSYS;
        const entry = requireDirectory(fd, RIGHTS_PATH_UNLINK_FILE);
        if (typeof entry === "number") return entry;
        const rel = readString(path_ptr, path_len);
        const fullPath = resolveCapabilityPath(entry, rel, false);
        fs.unlinkSync(fullPath);
        for (const open of fds.values()) {
          if (open.kind === FdKind.File && open.path === fullPath) open.unlinked = true;
        }
        return ERRNO_SUCCESS;
      },
    ),

    /* ---- misc ---------------------------------------------------- */

    poll_oneoff: syscall(
      (
        in_ptr: number,
        out_ptr: number,
        nsubscriptions: number,
        nevents_out: number,
      ): number => {
        if (nsubscriptions === 0) return ERRNO_INVAL;
        const dv = view();
        const clocks: Array<{ userdata: bigint; type: number; clockId: number; deadlineNs: bigint; delayNs: bigint }> = [];
        const ready: Array<{ userdata: bigint; type: number; error: number; nbytes: bigint }> = [];

        for (let i = 0; i < nsubscriptions; i++) {
          const subPtr = in_ptr + i * 48;
          const userdata = dv.getBigUint64(subPtr, true);
          const eventType = dv.getUint8(subPtr + 8);
          if (eventType === EVENTTYPE_CLOCK) {
            const clockId = dv.getUint32(subPtr + 16, true);
            const timeout = dv.getBigUint64(subPtr + 24, true);
            const flags = dv.getUint16(subPtr + 40, true);
            if ((flags & ~SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0) {
              ready.push({ userdata, type: eventType, error: ERRNO_INVAL, nbytes: 0n });
              continue;
            }
            let nowNs: bigint;
            if (clockId === CLOCKID_REALTIME) nowNs = BigInt(Date.now()) * 1_000_000n;
            else if (clockId === CLOCKID_MONOTONIC) nowNs = BigInt(Math.floor(performance.now() * 1e6));
            else {
              ready.push({ userdata, type: eventType, error: ERRNO_NOSYS, nbytes: 0n });
              continue;
            }
            const deadlineNs = flags & SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME ? timeout : nowNs + timeout;
            clocks.push({
              userdata,
              type: eventType,
              clockId,
              deadlineNs,
              delayNs: deadlineNs > nowNs ? deadlineNs - nowNs : 0n,
            });
          } else if (eventType === EVENTTYPE_FD_READ || eventType === EVENTTYPE_FD_WRITE) {
            const fd = dv.getUint32(subPtr + 16, true);
            const entry = fds.get(fd);
            if (!entry) {
              ready.push({ userdata, type: eventType, error: ERRNO_BADF, nbytes: 0n });
              continue;
            }
            const right = RIGHTS_POLL_FD_READWRITE;
            const error = requireRight(entry, right);
            let nbytes = 0n;
            if (error === ERRNO_SUCCESS && eventType === EVENTTYPE_FD_READ && entry.kind === FdKind.File) {
              nbytes = BigInt(Math.max(0, (entry.data?.length ?? 0) - (entry.offset ?? 0)));
            }
            ready.push({ userdata, type: eventType, error, nbytes });
          } else {
            ready.push({ userdata, type: eventType, error: ERRNO_INVAL, nbytes: 0n });
          }
        }

        if (ready.length === 0 && clocks.length > 0) {
          const earliest = clocks.reduce((a, b) => a.delayNs < b.delayNs ? a : b);
          const delayMs = Number((earliest.delayNs + 999_999n) / 1_000_000n);
          if (delayMs > 0) {
            try {
              const waitBuffer = new SharedArrayBuffer(4);
              Atomics.wait(new Int32Array(waitBuffer), 0, 0, delayMs);
            } catch {
              return ERRNO_NOTSUP;
            }
          }
          const afterRealtime = BigInt(Date.now()) * 1_000_000n;
          const afterMonotonic = BigInt(Math.floor(performance.now() * 1e6));
          for (const clock of clocks) {
            const after = clock.clockId === CLOCKID_REALTIME ? afterRealtime : afterMonotonic;
            if (clock.deadlineNs <= after) ready.push({ userdata: clock.userdata, type: clock.type, error: 0, nbytes: 0n });
          }
        }

        for (let i = 0; i < ready.length; i++) {
          const event = ready[i];
          const eventPtr = out_ptr + i * 32;
          dv.setBigUint64(eventPtr, event.userdata, true);
          dv.setUint16(eventPtr + 8, event.error, true);
          dv.setUint8(eventPtr + 10, event.type);
          dv.setBigUint64(eventPtr + 16, event.nbytes, true);
          dv.setUint16(eventPtr + 24, 0, true);
        }
        dv.setUint32(nevents_out, ready.length, true);
        return ERRNO_SUCCESS;
      },
    ),

    proc_exit: syscall((rval: number): never => {
      // flush remaining output
      stdoutBuf += stdoutDecoder.decode();
      stderrBuf += stderrDecoder.decode();
      if (stdoutBuf) {
        console.log(stdoutBuf);
        stdoutBuf = "";
      }
      if (stderrBuf) {
        console.error(stderrBuf);
        stderrBuf = "";
      }
      throw new ExitStatus(rval);
    }),

    proc_raise: syscall((_sig: number): number => {
      return ERRNO_NOSYS;
    }),

    sched_yield: syscall((): number => {
      return ERRNO_SUCCESS;
    }),

    random_get: syscall((buf_ptr: number, buf_len: number): number => {
      const mem = getMemory();
      if (buf_ptr < 0 || buf_len < 0 || buf_ptr + buf_len > mem.buffer.byteLength || buf_ptr + buf_len < buf_ptr) {
        return ERRNO_OVERFLOW;
      }
      const destination = new Uint8Array(mem.buffer, buf_ptr, buf_len);
      for (let offset = 0; offset < buf_len; offset += 65_536) {
        const length = Math.min(65_536, buf_len - offset);
        if (mem.buffer instanceof SharedArrayBuffer) {
          const tmp = new Uint8Array(length);
          crypto.getRandomValues(tmp);
          destination.set(tmp, offset);
        } else {
          crypto.getRandomValues(destination.subarray(offset, offset + length));
        }
      }
      return ERRNO_SUCCESS;
    }),

    sock_recv: syscall((): number => ERRNO_NOSYS),
    sock_send: syscall((): number => ERRNO_NOSYS),
    sock_shutdown: syscall((): number => ERRNO_NOSYS),
    sock_accept: syscall((): number => ERRNO_NOSYS),
  };

  /* public api */

  const self: any = this;
  self.wasiImport = wasiImport;

  self.finalizeBindings = function finalizeBindings(
    wasmInstance: any,
    finalizeOptions?: { memory?: WebAssembly.Memory },
  ): void {
    if (bindingsFinalized) throw new Error("WASI instance has already been started");
    if (!wasmInstance || typeof wasmInstance !== "object" || !wasmInstance.exports) {
      throw new TypeError('The "instance" argument must be a WebAssembly.Instance');
    }
    const selectedMemory = finalizeOptions?.memory ?? wasmInstance.exports.memory;
    if (!(selectedMemory instanceof WebAssembly.Memory)) {
      throw new TypeError('The "options.memory" property must be a WebAssembly.Memory');
    }
    instance = wasmInstance;
    memory = selectedMemory;
    bindingsFinalized = true;
  };

  self.start = function start(wasmInstance: any): number {
    const _start = wasmInstance.exports._start;
    if (typeof _start !== "function") {
      throw new Error("WASI: instance has no _start export");
    }
    if (typeof wasmInstance.exports._initialize === "function") {
      throw new Error("WASI: instance exports both _start and _initialize");
    }
    self.finalizeBindings(wasmInstance);

    try {
      _start();
    } catch (err) {
      if (err instanceof ExitStatus) {
        if (returnOnExit) return err.code;
        throw err;
      }
      throw err;
    } finally {
      // flush remaining output
      stdoutBuf += stdoutDecoder.decode();
      stderrBuf += stderrDecoder.decode();
      if (stdoutBuf) {
        console.log(stdoutBuf);
        stdoutBuf = "";
      }
      if (stderrBuf) {
        console.error(stderrBuf);
        stderrBuf = "";
      }
    }
    return 0;
  };

  self.initialize = function initialize(wasmInstance: any): void {
    if (typeof wasmInstance?.exports?._start === "function") {
      throw new Error("WASI: initialize() cannot be used with a command module exporting _start");
    }
    self.finalizeBindings(wasmInstance);

    const _initialize = wasmInstance?.exports?._initialize;
    if (typeof _initialize === "function") {
      try {
        _initialize();
      } catch (err: any) {
        console.error("[WASI] _initialize() failed:", err?.message || err);
        throw err;
      }
    }
  };

  self.getImportObject = function getImportObject(): Record<
    string,
    Record<string, Function>
  > {
    return version === "unstable"
      ? { wasi_unstable: wasiImport }
      : { wasi_snapshot_preview1: wasiImport };
  };
} as unknown as WASIConstructor;

export function getWasiRuntimeSource(globalName = "__nodepodWasi"): string {
  const constants = {
    ERRNO_SUCCESS, ERRNO_2BIG, ERRNO_ACCES, ERRNO_BADF, ERRNO_EXIST,
    ERRNO_FAULT, ERRNO_INVAL, ERRNO_IO, ERRNO_ISDIR, ERRNO_LOOP, ERRNO_NOENT,
    ERRNO_NOSYS, ERRNO_NOTDIR, ERRNO_NOTEMPTY, ERRNO_NOTSUP,
    ERRNO_OVERFLOW, ERRNO_PERM, ERRNO_PIPE, ERRNO_ROFS, ERRNO_SPIPE,
    ERRNO_XDEV, ERRNO_NOTCAPABLE, CLOCKID_REALTIME, CLOCKID_MONOTONIC,
    CLOCKID_PROCESS_CPUTIME_ID, CLOCKID_THREAD_CPUTIME_ID,
    FILETYPE_UNKNOWN, FILETYPE_CHARACTER_DEVICE, FILETYPE_DIRECTORY,
    FILETYPE_REGULAR_FILE, FILETYPE_SYMBOLIC_LINK, FDFLAGS_APPEND,
    FDFLAGS_DSYNC, FDFLAGS_NONBLOCK, FDFLAGS_RSYNC, FDFLAGS_SYNC,
    FDFLAGS_MASK, FSTFLAGS_ATIM, FSTFLAGS_ATIM_NOW, FSTFLAGS_MTIM,
    FSTFLAGS_MTIM_NOW, OFLAGS_CREAT, OFLAGS_DIRECTORY, OFLAGS_EXCL,
    OFLAGS_TRUNC, LOOKUPFLAGS_SYMLINK_FOLLOW, WHENCE_SET, WHENCE_CUR,
    WHENCE_END, PREOPENTYPE_DIR, EVENTTYPE_CLOCK, EVENTTYPE_FD_READ,
    EVENTTYPE_FD_WRITE, SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
  };
  const bigintConstants = {
    RIGHTS_FD_READ, RIGHTS_FD_DATASYNC, RIGHTS_FD_WRITE, RIGHTS_FD_SEEK,
    RIGHTS_FD_FDSTAT_SET_FLAGS, RIGHTS_FD_SYNC, RIGHTS_FD_TELL,
    RIGHTS_FD_ADVISE, RIGHTS_FD_ALLOCATE, RIGHTS_FD_READDIR,
    RIGHTS_PATH_OPEN, RIGHTS_PATH_CREATE_DIRECTORY, RIGHTS_PATH_CREATE_FILE,
    RIGHTS_PATH_LINK_SOURCE, RIGHTS_PATH_LINK_TARGET,
    RIGHTS_PATH_UNLINK_FILE, RIGHTS_PATH_REMOVE_DIRECTORY,
    RIGHTS_PATH_RENAME_SOURCE, RIGHTS_PATH_RENAME_TARGET,
    RIGHTS_PATH_FILESTAT_GET, RIGHTS_PATH_FILESTAT_SET_SIZE,
    RIGHTS_PATH_FILESTAT_SET_TIMES, RIGHTS_PATH_SYMLINK,
    RIGHTS_PATH_READLINK, RIGHTS_FD_FILESTAT_GET,
    RIGHTS_FD_FILESTAT_SET_SIZE, RIGHTS_FD_FILESTAT_SET_TIMES,
    RIGHTS_POLL_FD_READWRITE, RIGHTS_ALL, RIGHTS_DIR_BASE, RIGHTS_FILE_BASE,
  };
  const runtimeReferences = {
    ExitStatus,
    syscall,
    pathError,
    joinPath,
    normalizePath,
    decodeFromMemory,
    encoder,
    decoder,
    _wasiSyscallErrorLogged,
  };
  const ownSource = getWasiRuntimeSource.toString();
  const emittedName = (canonical: string): string => {
    const match = ownSource.match(new RegExp(`(?:[{,])${canonical}:([A-Za-z_$][\\w$]*)`));
    return match?.[1] ?? canonical;
  };
  const declarations = [
    ...Object.entries(constants).map(([name, value]) => `const ${emittedName(name)}=${value};`),
    ...Object.entries(bigintConstants).map(([name, value]) => `const ${emittedName(name)}=${value}n;`),
  ].join("");
  const referenceName = (name: keyof typeof runtimeReferences): string => emittedName(name);
  return `${declarations}
const FdKind={Stdin:0,Stdout:1,Stderr:2,PreopenDir:3,Directory:4,File:5};
let ${referenceName("_wasiSyscallErrorLogged")}=false;
const ${referenceName("encoder")}=new TextEncoder();const ${referenceName("decoder")}=new TextDecoder();
const ${referenceName("ExitStatus")}=${ExitStatus.toString()};
const ${referenceName("syscall")}=${syscall.toString()};
const ${referenceName("pathError")}=${pathError.toString()};
const ${referenceName("joinPath")}=${joinPath.toString()};
const ${referenceName("normalizePath")}=${normalizePath.toString()};
const ${referenceName("decodeFromMemory")}=${decodeFromMemory.toString()};
const WASI=${WASI.toString()};
globalThis[${JSON.stringify(globalName)}]={WASI,ExitStatus:${referenceName("ExitStatus")}};`;
}

/*  matches Node.js `require('wasi')` */
export default {
  WASI,
};
