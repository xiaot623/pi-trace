import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  timestamp: number;
  args: any[];
}

class Logger {
  private logDir: string | null = null;
  private stream: WriteStream | null = null;
  private currentDateStr: string | null = null;
  private buffer: LogEntry[] = [];

  public init(dir: string) {
    if (this.logDir) return;
    this.logDir = dir;
    
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore if directory creation fails
    }
    
    // Flush buffered logs
    const currentBuffer = this.buffer;
    this.buffer = [];
    for (const entry of currentBuffer) {
      this.writeLog(entry.level, entry.timestamp, entry.args);
    }
  }

  public debug(...args: unknown[]) { this.log("debug", args); }
  public info(...args: unknown[]) { this.log("info", args); }
  public warn(...args: unknown[]) { this.log("warn", args); }
  public error(...args: unknown[]) { this.log("error", args); }

  private log(level: LogLevel, args: unknown[]) {
    const timestamp = Date.now();
    if (!this.logDir) {
      this.buffer.push({ level, timestamp, args });
      return;
    }
    this.writeLog(level, timestamp, args);
  }

  private writeLog(level: LogLevel, timestamp: number, args: unknown[]) {
    const date = new Date(timestamp);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    
    if (this.currentDateStr !== dateStr || !this.stream) {
      if (this.stream) {
        this.stream.end();
      }
      this.currentDateStr = dateStr;
      try {
        this.stream = createWriteStream(join(this.logDir!, `pi-trace-${dateStr}.log`), { flags: "a" });
        this.stream.on("error", () => {
          // Silently ignore stream errors to avoid crashing the main process
        });
      } catch {
        this.stream = null;
      }
    }

    if (this.stream) {
      const timeStr = date.toISOString();
      const msg = format(...args);
      const line = `[${timeStr}] [${level.toUpperCase()}] ${msg}\n`;
      this.stream.write(line);
    }
  }
}

export const logger = new Logger();
