// @vitest-environment jsdom
import { render, screen } from "@testing-library/vue";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import ErrorBoundary from "./ErrorBoundary.vue";

const Boom = defineComponent({
  setup() {
    throw new Error("boom");
  },
});

const Fine = defineComponent({
  setup() {
    return () => h("div", "fine");
  },
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(ErrorBoundary, { slots: { default: () => h(Fine) } });
    expect(screen.getByText("fine")).toBeInTheDocument();
  });

  it("shows the error message and a close button when a child throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(ErrorBoundary, { slots: { default: () => h(Boom) } });

    // The error is caught synchronously (onErrorCaptured runs mid-render),
    // but the fallback branch (v-if flipping on the now-set error ref) only
    // actually commits on Vue's next reactive flush -- findBy* waits for it.
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    consoleError.mockRestore();
  });

  it("renders the fallback as a full-viewport overlay, not an inline banner", async () => {
    // A known React reconciler edge case (see ErrorBoundary.vue's own
    // comment) could leave the previous screen's real DOM behind, still
    // visible and clickable -- doesn't apply to Vue's patching model, but
    // the overlay is kept as generally good crash UX regardless.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { container } = render(ErrorBoundary, { slots: { default: () => h(Boom) } });

    const alert = await screen.findByRole("alert");
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain("position-fixed");
    expect(overlay.className).toContain("w-100");
    expect(overlay.className).toContain("h-100");
    expect(alert).toHaveTextContent(/unlock your library again/i);

    consoleError.mockRestore();
  });

  it("dismissing clears the error and re-renders children fresh", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const shouldThrow = ref(true);
    const MaybeBoom = defineComponent({
      setup() {
        if (shouldThrow.value) throw new Error("boom");
        return () => h("div", "recovered");
      },
    });

    render(ErrorBoundary, { slots: { default: () => h(MaybeBoom) } });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    shouldThrow.value = false;
    await screen.getByRole("button", { name: "Close" }).click();

    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    consoleError.mockRestore();
  });
});
