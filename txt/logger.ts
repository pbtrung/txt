export interface Logger {
  // Whether debug() actually prints anything -- lazyPageClient.ts's
  // startLazyPageWorker reads this to tell its own worker_threads Worker
  // (which can't share this Logger object across threads, only
  // structured-cloneable data) whether to build its own verbose or quiet
  // ConsoleLogger.
  readonly verbose: boolean;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// Timestamped console logger. debug() only prints under --verbose; the rest
// always print. No global/singleton state -- one instance is built in
// txt/cli.ts and passed explicitly to everything that logs.
export class ConsoleLogger implements Logger {
  readonly verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  private line(level: string, msg: string, out: (s: string) => void): void {
    out(`${new Date().toISOString()} ${level.padEnd(6)} ${msg}`);
  }

  debug(msg: string): void {
    if (this.verbose) this.line("DEBUG", msg, console.log);
  }

  info(msg: string): void {
    this.line("INFO", msg, console.log);
  }

  warn(msg: string): void {
    this.line("WARN", msg, console.log);
  }

  error(msg: string): void {
    this.line("ERROR", msg, console.error);
  }
}
