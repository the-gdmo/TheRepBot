import chalk from "chalk";
import { TriggerContext } from "@devvit/public-api";

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

// Environment config

function formatMessage(level: LogLevel, message: string, context?: Record<string, any>): string {
  const timestamp = new Date().toISOString();
  const contextString = context ? ` ${JSON.stringify(context, null, 2)}` : "";
  return `[${timestamp}] [${level}] ${message}${contextString}`;
}

function colorize(level: LogLevel, message: string): string {
  switch (level) {
    case LogLevel.INFO: return chalk.blue(message);
    case LogLevel.WARN: return chalk.yellow(message);
    case LogLevel.ERROR: return chalk.red(message);
    case LogLevel.DEBUG: return chalk.gray(message);
    default: return message;
  }
}

async function sendModPM(context: TriggerContext, message: string): Promise<void> {
  try {
    const subreddit = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
    await context.reddit.sendPrivateMessage({
      to: `/r/${subreddit}`,
      subject: "TheRepBot Error Alert",
      text: message.slice(0, 10_000),
    });
  } catch (e) {
    console.error("Logger: Failed to send Reddit PM:", e);
  }
}

function logToConsole(level: LogLevel, coloredMsg: string): void {
  switch (level) {
    case LogLevel.INFO:
      console.info(coloredMsg);
      break;
    case LogLevel.DEBUG:
      console.debug(coloredMsg);
      break;
    case LogLevel.WARN:
      console.warn(coloredMsg);
      break;
    case LogLevel.ERROR:
      console.error(coloredMsg);
      break;
    default:
      console.info(coloredMsg);
  }
}

export const logger = {
  info: (message: string, placeholders?: Record<string, any>) => {
    const msg = formatMessage(LogLevel.INFO, message, placeholders);
    const colored = colorize(LogLevel.INFO, msg);
    logToConsole(LogLevel.INFO, colored);
  },
  warn: (message: string, placeholders?: Record<string, any>) => {
    const msg = formatMessage(LogLevel.WARN, message, placeholders);
    const colored = colorize(LogLevel.WARN, msg);
    logToConsole(LogLevel.WARN, colored);
  },
  debug: (message: string, placeholders?: Record<string, any>) => {
    const msg = formatMessage(LogLevel.DEBUG, message, placeholders);
    const colored = colorize(LogLevel.DEBUG, msg);
    logToConsole(LogLevel.DEBUG, colored); // ✅ was console.debug
  },
  error: async (
    message: string,
    placeholders?: Record<string, any>,
    triggerContext?: TriggerContext
  ) => {
    const msg = formatMessage(LogLevel.ERROR, message, placeholders);
    const colored = colorize(LogLevel.ERROR, msg);
    logToConsole(LogLevel.ERROR, colored);
    if (triggerContext) {
      await sendModPM(triggerContext, msg);
    }
  },
};