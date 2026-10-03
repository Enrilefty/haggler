import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency). Values never logged.
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
export const env = (k: string) => (process.env[k] ?? "").trim();
export const has = (...keys: string[]) => keys.every((k) => env(k) !== "");

export const STATE_DIR = join(ROOT, ".state");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

export const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

export const integrations = () => ({
  zoowork: has("ZOOWORK_API_KEY"),
  band: has("BAND_BUYER_ID", "BAND_BUYER_KEY", "BAND_DRIVE_ID", "BAND_DRIVE_KEY", "BAND_SHOPB_ID", "BAND_SHOPB_KEY"),
  telegram: has("TELEGRAM_BOT_TOKEN"),
  telegramOwner: has("TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID"),
  tavily: has("TAVILY_API_KEY"),
  novita: has("NOVITA_API_KEY"),
});
