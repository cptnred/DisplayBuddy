/**
 * German texts of the section „Konto & Handy“ (PLAN_V4 §10). Command errors are strings
 * "code: detail" (PLAN_V4 §7.1); only the code is used here, the detail is never shown.
 */
import { needsClockWarning } from "../../lib/clock";
import { DEFAULT_SYNC_SERVER_URL, type DeviceInfo, type SyncStatus } from "../../types";

export const DEFAULT_DEVICE_NAME = "Windows-PC";

/** Code part of a command error ("username_taken: HTTP 409" → "username_taken"). */
export function errorCode(error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return raw.split(":")[0].trim();
}

/** Context decides what "unauthorized" means. */
export type ErrorContext = "login" | "register" | "recover" | "password" | "general";

const TEXTS: Record<string, string> = {
  username_taken: "Dieser Benutzername ist schon vergeben.",
  username_invalid: "Der Benutzername erfüllt die Regeln nicht.",
  password_weak: "Dieses Passwort ist zu kurz oder zu leicht zu erraten.",
  registration_closed: "Auf diesem Server kann man sich nicht selbst registrieren.",
  invite_required: "Dieser Server braucht einen Einladungscode.",
  invite_invalid: "Der Einladungscode ist ungültig oder abgelaufen.",
  too_many_requests: "Zu viele Versuche. Bitte später erneut versuchen.",
  server_too_old: "Dieser Server ist zu alt für diese Funktion (Display-Buddy-Server ab Version 0.4 nötig).",
  account_disabled: "Das Konto ist gesperrt.",
  device_limit: "Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden.",
  quota_exceeded: "Der Speicher deines Kontos ist voll. Lösche oder kürze Notizen, damit wieder synchronisiert wird.",
  pow_timeout: "Das Anlegen hat zu lange gedauert. Bitte erneut versuchen.",
  challenge_invalid: "Das Anlegen hat zu lange gedauert. Bitte erneut versuchen.",
  pairing_invalid: "Der Code ist ungültig, abgelaufen oder wurde schon benutzt.",
  password_required: "Dieses Gerät wurde vor deinem angemeldet. Zum Abmelden bitte dein Passwort eingeben.",
  invalid_url: "Ungültige Server-Adresse. Erlaubt ist https://… (http:// nur für localhost).",
  offline: "Server nicht erreichbar. Bitte Adresse und Internetverbindung prüfen.",
  keyring: "Die Anmeldung konnte nicht im Windows-Anmeldeinformationsspeicher abgelegt werden.",
};

const UNAUTHORIZED: Record<ErrorContext, string> = {
  login: "Benutzername oder Passwort ist falsch.",
  register: "Der Server hat die Anfrage abgelehnt.",
  recover: "Benutzername oder Wiederherstellungscode ist falsch.",
  password: "Das Passwort ist falsch.",
  general: "Abgemeldet – bitte neu verbinden.",
};

const INVALID_INPUT: Record<ErrorContext, string> = {
  login: "Bitte Benutzername, Passwort und Gerätenamen (höchstens 64 Zeichen) angeben.",
  register: "Bitte alle Felder ausfüllen (Gerätename höchstens 64 Zeichen).",
  recover: "Bitte den Wiederherstellungscode vollständig eingeben (24 Zeichen).",
  password: "Bitte alle Felder ausfüllen.",
  general: "Ungültige Eingabe.",
};

/** German text for a command error. */
export function accountErrorText(error: unknown, context: ErrorContext = "general"): string {
  const code = errorCode(error);
  if (code === "unauthorized") return UNAUTHORIZED[context];
  if (code === "invalid_input") return INVALID_INPUT[context];
  return TEXTS[code] ?? (context === "login" ? "Verbinden fehlgeschlagen." : "Das hat nicht geklappt. Bitte später erneut versuchen.");
}

/** Host shown in „Server: …“ ("" = standard server). */
export function serverHost(serverUrl: string): string {
  const url = serverUrl.trim() || DEFAULT_SYNC_SERVER_URL;
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function pendingText(n: number): string {
  return n === 1 ? "1 Änderung wartet" : `${n} Änderungen warten`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(d);
}

/** German status line for a sync status. */
export function statusText(s: SyncStatus): string {
  if (!s.enabled) return "Nicht verbunden";
  switch (s.state) {
    case "syncing":
      return "Synchronisiere …";
    case "offline":
      return `Offline – ${pendingText(s.pending)}`;
    case "error":
      return s.pending > 0 ? `Fehler bei der Synchronisation – ${pendingText(s.pending)}` : "Fehler bei der Synchronisation";
    case "unauthorized":
      return "Abgemeldet – bitte neu verbinden";
    case "off":
      return "Nicht verbunden";
    case "idle":
    default:
      if (s.pending > 0) return `Verbunden – ${pendingText(s.pending)}`;
      return s.lastSyncAt ? `Synchronisiert – zuletzt ${formatTime(s.lastSyncAt)}` : "Verbunden";
  }
}

/** Hint for local changes replaced by newer versions (`message` = "stale:<n>"). */
export function staleText(s: SyncStatus): string | null {
  const m = /^stale:(\d+)$/.exec(s.message ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return n === 1
    ? "1 Änderung wurde durch eine neuere Fassung von einem anderen Gerät ersetzt."
    : `${n} Änderungen wurden durch neuere Fassungen von anderen Geräten ersetzt.`;
}

/** Sync errors with their own hint (quota, disabled account). */
export function syncProblemText(s: SyncStatus): string | null {
  if (!s.enabled) return null;
  const m = s.message ?? "";
  if (m.includes("quota_exceeded")) return TEXTS.quota_exceeded;
  if (m.includes("account_disabled")) return TEXTS.account_disabled;
  return null;
}

/** Clock warning for |offset| > 2 min (positive offset = this PC is behind). */
export function clockWarningText(s: SyncStatus): string | null {
  if (!s.enabled || !needsClockWarning(s.clockOffsetMs)) return null;
  const minutes = Math.round(Math.abs(s.clockOffsetMs) / 60_000);
  const dir = s.clockOffsetMs > 0 ? "nach" : "vor";
  return `Die Uhr dieses PCs geht etwa ${minutes} Min. ${dir}. Zeitstempel werden korrigiert – bitte die Windows-Uhrzeit prüfen.`;
}

export const DEVICE_KIND_TEXT: Record<DeviceInfo["kind"], string> = {
  desktop: "PC",
  mobile: "Handy-App",
  web: "Web-App",
};

/** „heute 09:12“, „gestern 18:00“ or a short date (display only, local time of the PC). */
export function lastSeenText(iso: string | null, now: Date): string {
  if (!iso) return "zuletzt aktiv: unbekannt";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "zuletzt aktiv: unbekannt";
  const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(d);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `zuletzt aktiv: heute ${time}`;
  if (diff === 1) return `zuletzt aktiv: gestern ${time}`;
  return `zuletzt aktiv: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(d)}`;
}

const MIB = 1024 * 1024;

/** Binary units, so the quota 52 428 800 reads „50 MB“ like in the plan. */
export function formatBytes(bytes: number): string {
  if (bytes < MIB) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / MIB)} MB`;
}

/** „2:41“ */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
