// @vitest-environment jsdom
import { render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";

import App from "./App.vue";
import { createAppRouter } from "./router";

describe("App", () => {
  it("renders the Skypiea wordmark", async () => {
    const router = createAppRouter("https:");
    await router.push("/");
    render(App, { global: { plugins: [router] } });
    expect(screen.getByText("Skypiea")).toBeInTheDocument();
  });
});
