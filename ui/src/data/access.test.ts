import { describe, expect, it } from "vitest";

import {
  ACCESS_MAX_ENTRIES,
  clearReadPosition,
  decodeAccessContent,
  encodeAccessContent,
  setReadPosition,
  type AccessMap,
} from "./access";

describe("setReadPosition / clearReadPosition", () => {
  it("records a position that reads back correctly", () => {
    let map: AccessMap = {};
    map = setReadPosition(map, "txt-1", {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
    expect(map["txt-1"]).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
  });

  it("overwrites a previously recorded position", () => {
    let map: AccessMap = {};
    map = setReadPosition(map, "txt-1", {
      lastPartNum: 1,
      lastAccessedMs: 1000,
    });
    map = setReadPosition(map, "txt-1", {
      lastPartNum: 7,
      lastAccessedMs: 9000,
    });
    expect(map["txt-1"]).toEqual({ lastPartNum: 7, lastAccessedMs: 9000 });
  });

  it("evicts the oldest entry once past ACCESS_MAX_ENTRIES", () => {
    let map: AccessMap = {};
    for (let i = 0; i < ACCESS_MAX_ENTRIES; i++) {
      map = setReadPosition(map, `txt-${i}`, {
        lastPartNum: 1,
        lastAccessedMs: i,
      });
    }
    expect(Object.keys(map)).toHaveLength(ACCESS_MAX_ENTRIES);
    map = setReadPosition(map, "txt-new", {
      lastPartNum: 1,
      lastAccessedMs: 1000,
    });
    expect(Object.keys(map)).toHaveLength(ACCESS_MAX_ENTRIES);
    expect(map["txt-0"]).toBeUndefined(); // oldest (lastAccessedMs: 0) evicted
    expect(map["txt-new"]).toBeDefined();
  });

  it("clearReadPosition resets a recorded position back to never-opened", () => {
    let map: AccessMap = {};
    map = setReadPosition(map, "txt-1", {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
    map = clearReadPosition(map, "txt-1");
    expect(map["txt-1"]).toBeUndefined();
  });
});

describe("decodeAccessContent / encodeAccessContent", () => {
  it("round-trips a well-formed map", () => {
    const map: AccessMap = { "txt-1": { lastPartNum: 2, lastAccessedMs: 42 } };
    expect(decodeAccessContent(encodeAccessContent(map))).toEqual(map);
  });

  it("drops entries that don't match the expected shape", () => {
    const decoded = decodeAccessContent({
      "txt-1": { last_part_num: 1, last_accessed: 100 },
      "txt-2": { last_part_num: "not a number", last_accessed: 100 },
      "txt-3": "not even an object",
    });
    expect(decoded).toEqual({
      "txt-1": { lastPartNum: 1, lastAccessedMs: 100 },
    });
  });

  it("returns an empty map for non-object input", () => {
    expect(decodeAccessContent(null)).toEqual({});
    expect(decodeAccessContent("garbage")).toEqual({});
  });
});
