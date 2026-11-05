import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SettingsPatch } from "../../lib/api";
import {
  BUILTIN_SKINS,
  DEFAULT_SETTINGS,
  type BuddyConfig,
  type EyeStyle,
  type MouthStyle,
  type Settings,
  type SkinInfo,
} from "../../types";
import { BuddyAvatar } from "../buddy/BuddyAvatar";
import { BUILTIN_SKIN_INFO, skinFeatures } from "../buddy/skins";
import { SkinPicker } from "./SkinPicker";
import styles from "./SettingsApp.module.css";

const FACE_PRESETS: { label: string; value: string }[] = [
  { label: "Sonnengelb", value: "#FFD54A" },
  { label: "Orange", value: "#FFB74D" },
  { label: "Rosa", value: "#F8A5C2" },
  { label: "Mint", value: "#8EE3C8" },
  { label: "Himmelblau", value: "#8CC8FF" },
  { label: "Lavendel", value: "#C3B1F5" },
];

const EYES: { value: EyeStyle; label: string }[] = [
  { value: "round", label: "Rund" },
  { value: "lines", label: "Striche" },
  { value: "hearts", label: "Herzen" },
];

const MOUTHS: { value: MouthStyle; label: string }[] = [
  { value: "smile", label: "Lächeln" },
  { value: "wide", label: "Breit" },
  { value: "neutral", label: "Neutral" },
];

/** Delay for slider-driven saves so dragging a slider doesn't flood the backend. */
const SAVE_DELAY_MS = 150;

export function SettingsApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<SettingsPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skins, setSkins] = useState<SkinInfo[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .loadSettings()
      .then((s) => alive && setSettings(s))
      .catch(() => alive && setError("Einstellungen konnten nicht geladen werden."))
      .finally(() => alive && setLoaded(true));
    // Autostart: the OS registration is the source of truth.
    api
      .getAutostart()
      .then((on) => alive && setSettings((s) => ({ ...s, autostart: on })))
      .catch(() => undefined);
    // Re-apply not yet saved local edits on top, so a slider being dragged doesn't snap back
    // when another window (e.g. carousel navigation) broadcasts settings-changed.
    const unlisten = api.onSettingsChanged((s) => {
      const p = pending.current;
      setSettings({ ...s, ...p, buddy: { ...s.buddy, ...(p.buddy ?? {}) } } as Settings);
    });
    api
      .listSkins()
      .then((list) => alive && setSkins(list))
      .catch(() => alive && setError("Eigene Figuren konnten nicht geladen werden."));
    const unlistenSkins = api.onSkinsChanged((list) => alive && setSkins(list));
    return () => {
      alive = false;
      void unlisten.then((u) => u());
      void unlistenSkins.then((u) => u());
    };
  }, []);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    api.saveSettings(patch).then(
      () => setError(null),
      () => setError("Speichern fehlgeschlagen."),
    );
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);

  const update = useCallback(
    (patch: SettingsPatch, immediate = false) => {
      setSettings((s) => ({ ...s, ...patch, buddy: { ...s.buddy, ...(patch.buddy ?? {}) } }) as Settings);
      pending.current = {
        ...pending.current,
        ...patch,
        buddy: { ...(pending.current.buddy ?? {}), ...(patch.buddy ?? {}) },
      };
      if (!pending.current.buddy || Object.keys(pending.current.buddy).length === 0) {
        delete pending.current.buddy;
      }
      if (timer.current) clearTimeout(timer.current);
      if (immediate) flush();
      else timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  const setBuddy = (b: Partial<BuddyConfig>, immediate = false) => update({ buddy: b }, immediate);

  const toggleAutostart = async (enabled: boolean) => {
    setSettings((s) => ({ ...s, autostart: enabled }));
    try {
      const actual = await api.setAutostart(enabled);
      setSettings((s) => ({ ...s, autostart: actual }));
    } catch {
      setSettings((s) => ({ ...s, autostart: !enabled }));
      setError("Autostart konnte nicht geändert werden.");
    }
  };

  const b = settings.buddy;
  const features = skinFeatures(b.skin);

  const importSkin = async (): Promise<boolean> => {
    try {
      const info = await api.importSkin();
      if (!info) return false; // dialog cancelled
      setSkins((list) => (list.some((s) => s.id === info.id) ? list : [...list, info]));
      setBuddy({ skin: info.id }, true);
      setError(null);
      return true;
    } catch {
      setError("Import fehlgeschlagen. Erlaubt sind PNG, SVG, GIF, WebP oder Lottie-JSON bis 5 MB.");
      return false;
    }
  };

  const deleteSkin = async (info: SkinInfo): Promise<boolean> => {
    try {
      await api.deleteSkin(info.id);
      setSkins((list) => list.filter((s) => s.id !== info.id));
      // Rust resets an active skin to the smiley (and broadcasts settings-changed); mirror it now.
      setSettings((s) => (s.buddy.skin === info.id ? { ...s, buddy: { ...s.buddy, skin: "smiley" } } : s));
      setError(null);
      return true;
    } catch {
      setError("Die Figur konnte nicht gelöscht werden.");
      return false;
    }
  };

  return (
    <main className={styles.page} aria-busy={!loaded}>
      <header className={styles.header}>
        <h1>Einstellungen</h1>
      </header>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <section className={styles.previewSection} aria-label="Vorschau">
        <div className={styles.preview} data-testid="preview">
          <div style={{ width: b.size, height: b.size }}>
            <BuddyAvatar config={b} preview loadSkin={api.loadSkin} />
          </div>
        </div>
      </section>

      <section className={styles.group} aria-labelledby="sec-look">
        <h2 id="sec-look">Aussehen</h2>

        <SkinPicker
          config={b}
          builtins={BUILTIN_SKINS.map((id) => ({ id, name: BUILTIN_SKIN_INFO[id].label }))}
          custom={skins}
          loadSkin={api.loadSkin}
          onSelect={(skin) => setBuddy({ skin }, true)}
          onImport={importSkin}
          onDelete={deleteSkin}
        />

        {features.color && (
          <fieldset className={styles.field}>
            <legend>{b.skin === "smiley" ? "Gesichtsfarbe" : "Farbe"}</legend>
            <div className={styles.swatches}>
              {FACE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={styles.swatch}
                  style={{ background: p.value }}
                  aria-label={p.label}
                  aria-pressed={b.faceColor.toLowerCase() === p.value.toLowerCase()}
                  title={p.label}
                  onClick={() => setBuddy({ faceColor: p.value }, true)}
                />
              ))}
              <label className={styles.customColor} title="Eigene Farbe">
                <input
                  type="color"
                  aria-label="Eigene Farbe"
                  value={b.faceColor}
                  onChange={(e) => setBuddy({ faceColor: e.target.value })}
                />
              </label>
            </div>
          </fieldset>
        )}

        {features.eyes && (
          <fieldset className={styles.field}>
            <legend>Augen</legend>
            <div className={styles.segmented}>
              {EYES.map((o) => (
                <label key={o.value}>
                  <input
                    type="radio"
                    name="eyes"
                    value={o.value}
                    checked={b.eyeStyle === o.value}
                    onChange={() => setBuddy({ eyeStyle: o.value }, true)}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {features.mouth && (
          <fieldset className={styles.field}>
            <legend>Mund</legend>
            <div className={styles.segmented}>
              {MOUTHS.map((o) => (
                <label key={o.value}>
                  <input
                    type="radio"
                    name="mouth"
                    value={o.value}
                    checked={b.mouthStyle === o.value}
                    onChange={() => setBuddy({ mouthStyle: o.value }, true)}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <label className={styles.range}>
          <span>
            Größe <output>{b.size} px</output>
          </span>
          <input
            type="range"
            min={48}
            max={192}
            step={4}
            value={b.size}
            aria-label="Größe"
            onChange={(e) => setBuddy({ size: Number(e.target.value) })}
          />
        </label>

        <label className={styles.range}>
          <span>
            Deckkraft <output>{Math.round(b.opacity * 100)} %</output>
          </span>
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={Math.round(b.opacity * 100)}
            aria-label="Deckkraft"
            onChange={(e) => setBuddy({ opacity: Number(e.target.value) / 100 })}
          />
        </label>
      </section>

      <section className={styles.group} aria-labelledby="sec-anim">
        <h2 id="sec-anim">Animation</h2>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={!b.animate}
            onChange={(e) => setBuddy({ animate: !e.target.checked }, true)}
          />
          <span>Ruhiger Modus (keine Animationen)</span>
        </label>
        <label className={styles.range}>
          <span>
            Geschwindigkeit <output>{b.animationSpeed.toFixed(2).replace(".", ",")}×</output>
          </span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.25}
            value={b.animationSpeed}
            disabled={!b.animate}
            aria-label="Animationsgeschwindigkeit"
            onChange={(e) => setBuddy({ animationSpeed: Number(e.target.value) })}
          />
        </label>
      </section>

      <section className={styles.group} aria-labelledby="sec-reminders">
        <h2 id="sec-reminders">Erinnerungen</h2>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.reminderNotification}
            onChange={(e) => update({ reminderNotification: e.target.checked }, true)}
          />
          <span>Windows-Benachrichtigung anzeigen</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.reminderSound}
            onChange={(e) => update({ reminderSound: e.target.checked }, true)}
          />
          <span>Ton abspielen</span>
        </label>
      </section>

      <section className={styles.group} aria-labelledby="sec-system">
        <h2 id="sec-system">System</h2>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.autostart}
            onChange={(e) => void toggleAutostart(e.target.checked)}
          />
          <span>Mit Windows starten</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.globalShortcut}
            onChange={(e) => update({ globalShortcut: e.target.checked }, true)}
          />
          <span>
            Tastenkürzel <kbd>Strg</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> öffnet die Notizen
          </span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.hideNotesOnBlur}
            onChange={(e) => update({ hideNotesOnBlur: e.target.checked }, true)}
          />
          <span>Notizen bei Fokusverlust ausblenden (außer angeheftet)</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.clickThrough}
            onChange={(e) => update({ clickThrough: e.target.checked }, true)}
          />
          <span>Klicks auf die transparenten Ecken des Buddys durchlassen (experimentell)</span>
        </label>
      </section>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => update({ buddy: { ...DEFAULT_SETTINGS.buddy } }, true)}
        >
          Aussehen zurücksetzen
        </button>
      </footer>
    </main>
  );
}
