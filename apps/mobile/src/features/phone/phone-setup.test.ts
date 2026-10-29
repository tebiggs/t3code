import { describe, expect, it } from "vite-plus/test";

import { phoneServerPort } from "./phone-setup";

describe("phoneServerPort", () => {
  it("finds the phone's own servers by their loopback address", () => {
    expect(phoneServerPort("http://127.0.0.1:3773/")).toBe(3773);
    expect(phoneServerPort("http://localhost:3774")).toBe(3774);
  });

  it("leaves other machines alone", () => {
    expect(phoneServerPort("http://192.168.1.153:3773/")).toBeNull();
    expect(phoneServerPort("https://relay.example.test/")).toBeNull();
    expect(phoneServerPort("http://127.0.0.1.example.test:3773/")).toBeNull();
  });
});
