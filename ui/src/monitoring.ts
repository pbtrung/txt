import * as Sentry from "@sentry/react";
import type { RootOptions } from "react-dom/client";

const URL_IN_TEXT = /https?:\/\/[^\s)\]}]+/g;

export function initMonitoring(
  dsn = import.meta.env.VITE_SENTRY_DSN,
): RootOptions | undefined {
  const configuredDsn = dsn?.trim();
  if (!configuredDsn) return undefined;

  Sentry.init({
    dsn: configuredDsn,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    maxBreadcrumbs: 0,
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "Breadcrumbs"),
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeEvent,
  });

  const handler = Sentry.reactErrorHandler();
  return {
    onCaughtError: handler,
    onUncaughtError: handler,
    onRecoverableError: handler,
  };
}

function sanitizeEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.user;
  delete event.request;
  delete event.extra;
  delete event.breadcrumbs;
  event.message = redactUrls(event.message);
  if (event.logentry) event.logentry.message = redactUrls(event.logentry.message);
  for (const exception of event.exception?.values ?? []) {
    exception.value = redactUrls(exception.value);
  }
  return event;
}

function redactUrls(value: string | undefined): string | undefined {
  return value?.replace(URL_IN_TEXT, "[redacted URL]");
}
