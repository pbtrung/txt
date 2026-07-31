// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useDropdown } from "./useDropdown";

describe("useDropdown", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useDropdown());
    expect(result.current.open).toBe(false);
  });

  it("toggle() flips open/closed", () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });

  it("close() closes regardless of current state", () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.toggle());
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  it("closes on a mousedown outside the attached ref", async () => {
    const { result } = renderHook(() => useDropdown());
    const wrapper = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(wrapper, outside);
    act(() => {
      result.current.ref.current = wrapper;
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);

    await userEvent.click(outside);
    expect(result.current.open).toBe(false);

    wrapper.remove();
    outside.remove();
  });

  it("does not close on a click inside the attached ref", async () => {
    const { result } = renderHook(() => useDropdown());
    const wrapper = document.createElement("div");
    document.body.append(wrapper);
    act(() => {
      result.current.ref.current = wrapper;
      result.current.toggle();
    });

    await userEvent.click(wrapper);
    expect(result.current.open).toBe(true);

    wrapper.remove();
  });

  it("closes on Escape", async () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(result.current.open).toBe(false);
  });
});
