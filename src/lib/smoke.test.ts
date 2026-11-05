import { DEFAULT_SETTINGS } from "../types";
test("defaults are sane", () => {
  expect(DEFAULT_SETTINGS.buddy.size).toBe(96);
});
