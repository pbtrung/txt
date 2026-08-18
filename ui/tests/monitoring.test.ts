import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  reactErrorHandler: vi.fn(() => vi.fn()),
}));

import * as Sentry from "@sentry/react";
import { initMonitoring } from "../src/monitoring";

beforeEach(() => vi.clearAllMocks());

describe("initMonitoring", () => {
  it("does nothing without a configured DSN", () => {
    expect(initMonitoring("  ")).toBeUndefined();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initializes privacy-safe error reporting and React root handlers", () => {
    const handlers = initMonitoring(" https://public@example.test/1 ");
    const options = vi.mocked(Sentry.init).mock.calls[0][0];

    expect(options).toMatchObject({
      dsn: "https://public@example.test/1",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      maxBreadcrumbs: 0,
    });
    expect(options.beforeBreadcrumb?.({ category: "ui.click" }, {})).toBeNull();
    expect(handlers).toEqual({
      onCaughtError: expect.any(Function),
      onUncaughtError: expect.any(Function),
      onRecoverableError: expect.any(Function),
    });
    expect(Sentry.reactErrorHandler).toHaveBeenCalledOnce();
  });

  it("removes private context and URLs before sending an event", () => {
    initMonitoring("https://public@example.test/1");
    const options = vi.mocked(Sentry.init).mock.calls[0][0];
    const event = {
      type: undefined,
      message: "failed at https://r2.test/private/book?token=secret",
      user: { email: "reader@example.test" },
      request: { url: "https://reader.test/read/1?cfi=secret" },
      extra: { title: "Private title" },
      breadcrumbs: [{ message: "Clicked Private title" }],
      exception: {
        values: [
          {
            type: "Error",
            value: "GET https://r2.test/private/object?signature=secret failed",
          },
        ],
      },
    };

    const sanitized = options.beforeSend?.(event, {});

    expect(sanitized).toMatchObject({
      message: "failed at [redacted URL]",
      exception: {
        values: [{ value: "GET [redacted URL] failed" }],
      },
    });
    expect(sanitized).not.toHaveProperty("user");
    expect(sanitized).not.toHaveProperty("request");
    expect(sanitized).not.toHaveProperty("extra");
    expect(sanitized).not.toHaveProperty("breadcrumbs");
  });

  it("removes the automatic breadcrumb integration", () => {
    initMonitoring("https://public@example.test/1");
    const integrations = vi.mocked(Sentry.init).mock.calls[0][0].integrations;

    expect(typeof integrations).toBe("function");
    if (typeof integrations !== "function") return;
    expect(
      integrations([
        { name: "Breadcrumbs", setupOnce: vi.fn() },
        { name: "GlobalHandlers", setupOnce: vi.fn() },
      ]).map((integration) => integration.name),
    ).toEqual(["GlobalHandlers"]);
  });
});
