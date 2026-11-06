/** The shared API examples (round-tripped by buddy-core) also fit the TypeScript types. */
import examples from "../../../crates/buddy-core/tests/fixtures/api_examples.json";
import type * as T from "./types";

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
};

describe("api_examples.json", () => {
  it("covers every message type", () => {
    expect(Object.keys(check).sort()).toEqual(Object.keys(examples).filter((k) => k !== "$comment").sort());
    expect(typed.pushResponse.results.map((r) => r.status)).toEqual(["applied", "stale", "applied", "invalid"]);
  });
});
