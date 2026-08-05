import { describe, expect, it, vi } from "vitest";

vi.mock("@instantdb/react", () => ({ init: vi.fn(() => ({})) }));

import { init } from "@instantdb/react";
import { createInstantClient } from "./instantClient";

describe("createInstantClient", () => {
  it("passes devtool: false through to init()", () => {
    createInstantClient("app-1");
    expect(init).toHaveBeenCalledWith({ appId: "app-1", devtool: false });
  });
});
