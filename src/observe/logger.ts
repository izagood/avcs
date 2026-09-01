// Structured logging (docs/10 WS-F). JSON entries with a level + event + fields, sent
// to a pluggable sink. Production wires a console/OTel sink at the entry point (CLI/
// hub/MCP); the Repo defaults to silent so the test suite stays quiet.

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  #sink: (e: LogEntry) => void;
  #min: number;
  #level: LogLevel;
  #base: Record<string, unknown>;

  constructor(opts: { sink?: (e: LogEntry) => void; level?: LogLevel; base?: Record<string, unknown> } = {}) {
    this.#sink = opts.sink ?? (() => {});
    this.#level = opts.level ?? "info";
    this.#min = ORDER[this.#level];
    this.#base = opts.base ?? {};
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < this.#min) return;
    this.#sink({ ts: new Date().toISOString(), level, event, ...this.#base, ...fields });
  }
  debug(event: string, fields?: Record<string, unknown>): void { this.log("debug", event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.log("info", event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.log("warn", event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.log("error", event, fields); }

  /**
   * A logger that adds `fields` to every entry (request/actor context).
   *
   * The level carries over. Attaching context is not a decision about how much to log, and
   * omitting it here silently reset the child to the `info` default — so a child of a
   * warn-level logger logged MORE than its parent, and a child of a debug-level one logged
   * less. Either way the threshold the caller set stopped applying at the first `child()`.
   */
  child(fields: Record<string, unknown>): Logger {
    return new Logger({ sink: this.#sink, level: this.#level, base: { ...this.#base, ...fields } });
  }
}

/** Silent (default for libraries/tests). */
export function silentLogger(): Logger {
  return new Logger();
}
/** Emit one JSON object per line to stderr (default for CLI/servers). */
export function consoleLogger(level: LogLevel = "info"): Logger {
  return new Logger({ level, sink: (e) => process.stderr.write(JSON.stringify(e) + "\n") });
}
