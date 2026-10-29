import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  apiToken: string;
  demoMode: boolean;
  workerEnabled: boolean;
  retryBaseMs: number;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`Invalid numeric configuration: expected ${min}..${max}`);
  return number;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false")
    throw new Error("Boolean configuration must be true or false");
  return value === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.API_TOKEN ?? "";
  if (apiToken.length < 32 || /^(replace|change|your[-_])/i.test(apiToken)) {
    throw new Error(
      "Set a random API_TOKEN with at least 32 characters. Run npm run setup first.",
    );
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: integer(env.PORT, 3000, 1, 65535),
    databasePath: resolve(env.DATABASE_PATH ?? "data/relayforge.sqlite"),
    apiToken,
    demoMode: boolean(env.DEMO_MODE, false),
    workerEnabled: boolean(env.WORKER_ENABLED, true),
    retryBaseMs: integer(env.RETRY_BASE_MS, 1000, 100, 60000),
  };
}
