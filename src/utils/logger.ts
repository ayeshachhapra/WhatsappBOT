type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
};
const RESET = "\x1b[0m";

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, component: string, message: string, data?: any): string {
  const color = COLORS[level];
  const prefix = `${color}[${timestamp()}] [${level}] [${component}]${RESET}`;
  const dataStr =
    data !== undefined
      ? ` ${typeof data === "object" ? JSON.stringify(data) : data}`
      : "";
  return `${prefix} ${message}${dataStr}`;
}

function createLogger(component: string) {
  return {
    debug(message: string, data?: any) {
      console.log(format("DEBUG", component, message, data));
    },
    info(message: string, data?: any) {
      console.log(format("INFO", component, message, data));
    },
    warn(message: string, data?: any) {
      console.warn(format("WARN", component, message, data));
    },
    error(message: string, data?: any) {
      console.error(format("ERROR", component, message, data));
    },
  };
}

export default createLogger;
