// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/vue";
import userEvent from "@testing-library/user-event";
import { defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, RouterView, type Router } from "vue-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/vault", () => ({ useVault: vi.fn() }));

import UnlockScreen from "./UnlockScreen.vue";
import * as vaultModule from "../../state/vault";

const LibraryStub = defineComponent({ setup: () => () => h("div", "Library screen") });

// A real vue-router instance (memory history -- no real navigation needed
// for a test), same two routes the old <MemoryRouter><Routes>...</Routes>
// wrapper registered: UnlockScreen at "/", a stub at "/library" so its own
// status-watcher-triggered router.replace() has somewhere to actually land.
function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: UnlockScreen },
      { path: "/library", component: LibraryStub },
    ],
  });
}

async function renderUnlock() {
  const router = createTestRouter();
  await router.push("/");
  const AppStub = defineComponent({ setup: () => () => h(RouterView) });
  return render(AppStub, { global: { plugins: [router] } });
}

/** Defaults for the parts of the vault this screen doesn't exercise. */
function baseVault(overrides: Partial<ReturnType<typeof vaultModule.useVault>> = {}) {
  return {
    status: ref("locked"),
    session: ref(null),
    error: ref<string | null>(null),
    accessMap: ref(new Map()),
    bookmarksMap: ref(new Map()),
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof vaultModule.useVault>;
}

describe("UnlockScreen", () => {
  it("renders the wordmark and unlock button", async () => {
    vi.mocked(vaultModule.useVault).mockReturnValue(baseVault());
    await renderUnlock();
    expect(screen.getByText("Skypiea")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument();
  });

  it("calls unlock() with the chosen file", async () => {
    const unlock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vaultModule.useVault).mockReturnValue(baseVault({ unlock }));
    await renderUnlock();

    const file = new File(["{}"], "config.json", { type: "application/json" });
    const input = screen.getByLabelText(/choose config file/i) as HTMLInputElement;
    await userEvent.upload(input, file);

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock.mock.calls[0][0].name).toBe("config.json");
  });

  it("shows an error message when present", async () => {
    vi.mocked(vaultModule.useVault).mockReturnValue(baseVault({ error: ref("Incorrect password for this account.") }));
    await renderUnlock();
    expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password for this account.");
  });

  it("shows a spinner and status line while unlocking", async () => {
    vi.mocked(vaultModule.useVault).mockReturnValue(baseVault({ status: ref("unlocking") }));
    await renderUnlock();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/setting up your library/i)).toBeInTheDocument();
  });

  it("navigates to /library once unlocked", async () => {
    vi.mocked(vaultModule.useVault).mockReturnValue(baseVault({ status: ref("unlocked") }));
    await renderUnlock();
    await waitFor(() => expect(screen.getByText("Library screen")).toBeInTheDocument());
  });
});
