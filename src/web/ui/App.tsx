/**
 * Root of the web UI (PWA and native shell, PLAN_V3_SYNC §9.5). Everything
 * platform-specific comes in through `services` and `update`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DueBanner } from "./DueBanner";
import { useAccount, useDueTimer, useNotes, useReminders } from "./hooks";
import { LoginPage } from "./pages/LoginPage";
import { ListPage } from "./pages/ListPage";
import { NotePage } from "./pages/NotePage";
import { NewPage, SettingsPage, SetupPage } from "./pages/OtherPages";
import { PairPage } from "./pages/PairPage";
import { NoticeToast, noticeText, UpdateBanner } from "./Panels";
import { Link, RouterProvider, useRouter, type HistoryLike, type Route } from "./router";
import { SaveTrackerProvider } from "./saves";
import { ServicesProvider, useServices, type Services, type UpdateState } from "./services";
import { StatusBar } from "./StatusBar";
import styles from "./ui.module.css";

export interface AppProps {
  services: Services;
  history: HistoryLike;
  update?: UpdateState | null;
  /** Lets the entry point route the app (service worker „open /notes/<id>“). */
  onNavigatorReady?: (navigate: (path: string) => void) => void;
}

export function App({ services, history, update = null, onNavigatorReady }: AppProps) {
  return (
    <ServicesProvider value={services}>
      <RouterProvider history={history}>
        <SaveTrackerProvider>
          <Shell update={update} onNavigatorReady={onNavigatorReady} />
        </SaveTrackerProvider>
      </RouterProvider>
    </ServicesProvider>
  );
}

const TITLES: Record<Route["name"], string> = {
  login: "Display Buddy",
  list: "Notizen",
  note: "Notiz",
  new: "Neue Notiz",
  setup: "Einrichten",
  settings: "Einstellungen",
  pair: "Anmelden",
  notFound: "Nicht gefunden",
};

function Shell({
  update,
  onNavigatorReady,
}: {
  update: UpdateState | null;
  onNavigatorReady?: (navigate: (path: string) => void) => void;
}) {
  const { store, sync, notifier } = useServices();
  const { route, navigate } = useRouter();
  const [account, accountLoaded] = useAccount();
  const [notes, notesLoaded] = useNotes();
  const reminders = useReminders();
  const [notice, setNotice] = useState<string | null>(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  const signedIn = account !== null;
  const accountKey = account ? `${account.username}@${account.serverUrl}` : null;

  useDueTimer(reminders);

  useEffect(() => {
    onNavigatorReady?.((p) => navigate(p));
  }, [onNavigatorReady, navigate]);

  // Auth gate: runs on the first load and when the sign-in state flips – not on every
  // route change (after a login the login page itself goes on to /setup, while the
  // account change may still be on its way).
  const routeRef = useRef(route);
  routeRef.current = route;
  const gateSeen = useRef(false);
  useEffect(() => {
    if (!accountLoaded) return;
    const first = !gateSeen.current;
    gateSeen.current = true;
    const name = routeRef.current.name;
    if (!signedIn && name !== "login" && name !== "pair") navigate("/login", { replace: true });
    if (first && signedIn && name === "login" && sync.status().state !== "unauthorized") {
      navigate("/", { replace: true });
    }
  }, [accountLoaded, signedIn, navigate, sync]);

  // sync engine + push subscription check at every start (iOS: no pushsubscriptionchange)
  useEffect(() => {
    if (!accountKey) return;
    sync.start();
    sync.requestSync("start");
    void notifier?.reconcile().catch(() => undefined);
    return () => sync.stop();
  }, [accountKey, sync, notifier]);

  // local edits → debounced sync
  useEffect(
    () =>
      store.subscribe((c) => {
        if (c.source === "local" && (c.kind === "notes" || c.kind === "reminders" || c.kind === "order")) {
          sync.requestSync("change");
        }
      }),
    [store, sync],
  );

  // hints from the sync engine
  useEffect(
    () =>
      sync.onNotice((n) => {
        setNotice(noticeText(n));
        if (n.kind === "remoteDeleted" && route.name === "note" && route.id === n.id) navigate("/", { replace: true });
      }),
    [sync, route, navigate],
  );

  // app badge + close resolved notifications
  const noteIds = useMemo(() => notes.map((n) => n.id), [notes]);
  useEffect(() => {
    if (signedIn) void notifier?.syncDue(reminders, noteIds).catch(() => undefined);
  }, [notifier, reminders, noteIds, signedIn]);

  const reminderFor = (id: string) => reminders.find((r) => r.noteId === id) ?? null;

  let page;
  if (!accountLoaded) page = null;
  else if (route.name === "pair") page = <PairPage />;
  else if (route.name === "login" || !signedIn) page = <LoginPage />;
  else {
    switch (route.name) {
      case "list":
        page = <ListPage notes={notes} reminders={reminders} loaded={notesLoaded} />;
        break;
      case "note":
        page = <NotePage key={route.id} id={route.id} reminder={reminderFor(route.id)} />;
        break;
      case "new":
        page = <NewPage />;
        break;
      case "setup":
        page = <SetupPage />;
        break;
      case "settings":
        page = <SettingsPage />;
        break;
      default:
        page = (
          <main className={styles.main}>
            <p>Diese Seite gibt es nicht.</p>
            <Link to="/" className={styles.linkButton}>
              Zur Übersicht
            </Link>
          </main>
        );
    }
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        {signedIn && route.name !== "list" && route.name !== "login" && route.name !== "pair" && (
          <Link to="/" className={styles.iconButton} aria-label="Zurück zur Übersicht">
            ←
          </Link>
        )}
        <h1 className={styles.headerTitle}>{TITLES[route.name]}</h1>
        {signedIn && route.name !== "settings" && route.name !== "login" && route.name !== "pair" && (
          <Link to="/settings" className={styles.iconButton} aria-label="Einstellungen">
            ⚙
          </Link>
        )}
      </header>
      <div className={styles.banners}>
        <UpdateBanner update={update} />
        {signedIn && <DueBanner reminders={reminders} notes={notes} />}
      </div>
      {page}
      {signedIn && <StatusBar />}
      <NoticeToast notice={notice} onClose={closeNotice} />
    </div>
  );
}
