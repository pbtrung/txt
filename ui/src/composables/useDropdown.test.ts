// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { withSetup } from "../testUtils/withSetup";
import { useDropdown } from "./useDropdown";

describe("useDropdown", () => {
  it("starts closed", () => {
    const { result } = withSetup(() => useDropdown());
    expect(result.open.value).toBe(false);
  });

  it("toggle() flips open/closed", () => {
    const { result } = withSetup(() => useDropdown());
    result.toggle();
    expect(result.open.value).toBe(true);
    result.toggle();
    expect(result.open.value).toBe(false);
  });

  it("close() closes regardless of current state", () => {
    const { result } = withSetup(() => useDropdown());
    result.toggle();
    result.close();
    expect(result.open.value).toBe(false);
  });

  it("closes on a mousedown outside the attached ref", async () => {
    const { result } = withSetup(() => useDropdown());
    const wrapper = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(wrapper, outside);
    result.ref.value = wrapper;
    result.toggle();
    expect(result.open.value).toBe(true);

    await userEvent.click(outside);
    expect(result.open.value).toBe(false);

    wrapper.remove();
    outside.remove();
  });

  it("does not close on a click inside the attached ref", async () => {
    const { result } = withSetup(() => useDropdown());
    const wrapper = document.createElement("div");
    document.body.append(wrapper);
    result.ref.value = wrapper;
    result.toggle();

    await userEvent.click(wrapper);
    expect(result.open.value).toBe(true);

    wrapper.remove();
  });

  it("closes on Escape", async () => {
    const { result } = withSetup(() => useDropdown());
    result.toggle();
    expect(result.open.value).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(result.open.value).toBe(false);
  });
});
