/** The shared API examples (round-tripped by buddy-core) also fit the TypeScript types. */
import examples from "../../../crates/buddy-core/tests/fixtures/api_examples.json";
import type * as T from "./types";
import { API_LEVEL, EXPORT_FORMAT } from "./types";

type Examples = {
  syncChanges: T.SyncChanges;
  pushRequest: T.PushRequest;
  pushResponse: T.PushResponse;
  deviceLogin: T.DeviceLogin;
  deviceLoginResponse: T.DeviceLoginResponse;
  sessionLogin: T.SessionLogin;
  sessionResponse: T.SessionResponse;
  me: T.Me;
  meUpdate: T.MeUpdate;
  pushSubscription: T.PushSubscriptionJson;
  nativePushToken: T.NativePushToken;
  vapidPublicKey: T.VapidPublicKey;
  reminderPushPayload: T.ReminderPushPayload;
  apiError: T.ApiError;
  serverInfo: T.ServerInfo;
  registrationChallenge: T.RegistrationChallenge;
  accountCreate: T.AccountCreate;
  accountAccess: T.AccountAccess;
  accountRecover: T.AccountRecover;
  accountInfo: T.AccountInfo;
  deviceList: T.DeviceList;
  deviceRevoke: T.DeviceRevoke;
  passwordChange: T.PasswordChange;
  recoveryCodeRequest: T.RecoveryCodeRequest;
  recoveryCodeResponse: T.RecoveryCodeResponse;
  accountDelete: T.AccountDelete;
  accountExport: T.AccountExport;
  pairingStart: T.PairingStart;
  pairingStatus: T.PairingStatus;
  pairingRedeem: T.PairingRedeem;
  pairingAccess: T.PairingAccess;
  sessionPairing: T.SessionPairing;
};

// Compile-time check (npm run build / tsc): every example is assignable to its type.
const typed: Examples = examples as unknown as Examples;
const check: Examples = {
  syncChanges: examples.syncChanges as T.SyncChanges,
  pushRequest: examples.pushRequest as T.PushRequest,
  pushResponse: examples.pushResponse as T.PushResponse,
  deviceLogin: examples.deviceLogin as T.DeviceLogin,
  deviceLoginResponse: examples.deviceLoginResponse,
  sessionLogin: examples.sessionLogin,
  sessionResponse: examples.sessionResponse,
  me: examples.me,
  meUpdate: examples.meUpdate,
  pushSubscription: examples.pushSubscription,
  nativePushToken: examples.nativePushToken as T.NativePushToken,
  vapidPublicKey: examples.vapidPublicKey,
  reminderPushPayload: examples.reminderPushPayload as T.ReminderPushPayload,
  apiError: examples.apiError,
  serverInfo: examples.serverInfo as T.ServerInfo,
  registrationChallenge: examples.registrationChallenge,
  accountCreate: examples.accountCreate,
  accountAccess: examples.accountAccess,
  accountRecover: examples.accountRecover,
  accountInfo: examples.accountInfo,
  deviceList: examples.deviceList as T.DeviceList,
  deviceRevoke: examples.deviceRevoke,
  passwordChange: examples.passwordChange,
  recoveryCodeRequest: examples.recoveryCodeRequest,
  recoveryCodeResponse: examples.recoveryCodeResponse,
  accountDelete: examples.accountDelete,
  accountExport: examples.accountExport as T.AccountExport,
  pairingStart: examples.pairingStart,
  pairingStatus: examples.pairingStatus as T.PairingStatus,
  pairingRedeem: examples.pairingRedeem as T.PairingRedeem,
  pairingAccess: examples.pairingAccess,
  sessionPairing: examples.sessionPairing,
};

describe("api_examples.json", () => {
  it("covers every message type", () => {
    expect(Object.keys(check).sort()).toEqual(Object.keys(examples).filter((k) => k !== "$comment").sort());
    expect(typed.pushResponse.results.map((r) => r.status)).toEqual(["applied", "stale", "applied", "invalid"]);
    expect(typed.serverInfo.apiLevel).toBe(API_LEVEL);
    expect(typed.accountExport.format).toBe(EXPORT_FORMAT);
  });
});
