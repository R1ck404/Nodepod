// OS polyfill returning plausible Linux-like values


import { MOCK_OS, MOCK_IDS, MOCK_CPU, MOCK_MEMORY, MOCK_LOADAVG } from "../constants/config.js";

export function hostname(): string {
  return MOCK_OS.HOSTNAME;
}

export function platform(): string {
  return MOCK_OS.PLATFORM;
}

export function arch(): string {
  return MOCK_OS.ARCH;
}

export function type(): string {
  return MOCK_OS.TYPE;
}

export function release(): string {
  return MOCK_OS.RELEASE;
}

export function version(): string {
  return MOCK_OS.VERSION;
}

export function machine(): string {
  return MOCK_OS.MACHINE;
}

export function tmpdir(): string {
  return MOCK_OS.TMPDIR;
}

export function homedir(): string {
  return MOCK_OS.HOMEDIR;
}

interface CpuEntry {
  model: string;
  speed: number;
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

export function cpus(): CpuEntry[] {
  const template: CpuEntry = {
    model: MOCK_CPU.MODEL,
    speed: MOCK_CPU.SPEED,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return Array.from({ length: MOCK_CPU.COUNT }, () => ({ ...template }));
}

/** Node 18.14+ / 19+ — Metro and others use this for worker fan-out. */
export function availableParallelism(): number {
  return Math.max(1, MOCK_CPU.COUNT);
}

export function totalmem(): number {
  return MOCK_MEMORY.TOTAL;
}

export function freemem(): number {
  return MOCK_MEMORY.FREE;
}

export function uptime(): number {
  return Math.floor(performance.now() / 1000);
}

export function loadavg(): [number, number, number] {
  return [...MOCK_LOADAVG];
}

interface NetIface {
  address: string;
  netmask: string;
  family: string;
  mac: string;
  internal: boolean;
  cidr: string;
}

export function networkInterfaces(): Record<string, NetIface[]> {
  return {
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
  };
}

export function userInfo(): {
  username: string;
  uid: number;
  gid: number;
  shell: string;
  homedir: string;
} {
  return {
    username: MOCK_OS.USERNAME,
    uid: MOCK_IDS.UID,
    gid: MOCK_IDS.GID,
    shell: MOCK_OS.SHELL,
    homedir: MOCK_OS.HOMEDIR,
  };
}

export function endianness(): 'BE' | 'LE' {
  return MOCK_OS.ENDIANNESS;
}

export function getPriority(_pid?: number): number {
  return 0;
}

export function setPriority(_pidOrPriority: number, _priority?: number): void {
  // no-op in browser
}

export const EOL = '\n';

export const devNull = '/dev/null';

export const constants = {
  signals: {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGURG: 23,
    SIGXCPU: 24,
    SIGXFSZ: 25,
    SIGVTALRM: 26,
    SIGPROF: 27,
    SIGWINCH: 28,
    SIGIO: 29,
    SIGPWR: 30,
    SIGSYS: 31,
  },
  errno: {
    EPERM: -1,
    ENOENT: -2,
    ESRCH: -3,
    EINTR: -4,
    EIO: -5,
    ENXIO: -6,
    E2BIG: -7,
    ENOEXEC: -8,
    EBADF: -9,
    ECHILD: -10,
    EAGAIN: -11,
    ENOMEM: -12,
    EACCES: -13,
    EFAULT: -14,
    EBUSY: -16,
    EEXIST: -17,
    EXDEV: -18,
    ENODEV: -19,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    ENFILE: -23,
    EMFILE: -24,
    ENOTTY: -25,
    EFBIG: -27,
    ENOSPC: -28,
    ESPIPE: -29,
    EROFS: -30,
    EMLINK: -31,
    EPIPE: -32,
    EDOM: -33,
    ERANGE: -34,
    ENOTEMPTY: -39,
    ENOSYS: -38,
    ELOOP: -40,
    ENAMETOOLONG: -36,
    ECONNRESET: -104,
    ECONNREFUSED: -111,
    EADDRINUSE: -98,
    EADDRNOTAVAIL: -99,
    ETIMEDOUT: -110,
  },
  priority: {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  },
};

export default {
  hostname,
  platform,
  arch,
  type,
  release,
  version,
  machine,
  tmpdir,
  homedir,
  cpus,
  availableParallelism,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
  userInfo,
  endianness,
  getPriority,
  setPriority,
  EOL,
  devNull,
  constants,
};
