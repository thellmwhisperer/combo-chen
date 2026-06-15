import { describe, expect, it } from "vitest";

import type { ComboEvent } from "../core/events.js";
import {
  canonicalLgtmShaForHead,
  hasJournaledLgtm,
  hasMergedEvent,
  livePinnedLgtmSha,
  terminalReviewerEvent,
} from "./reviewer.js";

describe("cli reviewer journal helpers", () => {
  it("tracks the currently live LGTM pin through stale events", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "lgtm", sha: "abc123" },
      {
        t: "2026-06-11T00:01:00.000Z",
        event: "review_comment",
        url: "https://github.com/o/r/pull/7#issuecomment-1",
      },
      { t: "2026-06-11T00:02:00.000Z", event: "lgtm_stale", old_sha: "abc123", new_sha: "def456" },
      { t: "2026-06-11T00:03:00.000Z", event: "lgtm", sha: "def456" },
    ] satisfies ComboEvent[];

    expect(livePinnedLgtmSha(events)).toBe("def456");
    expect(hasJournaledLgtm(events, "abc123")).toBe(true);
    expect(hasJournaledLgtm(events, "fff999")).toBe(false);
  });

  it("canonicalizes short LGTM pins to the full PR head SHA", () => {
    const head = "e4e7dd43c6cc0d5f1234567890abcdef12345678";

    expect(canonicalLgtmShaForHead("e4e7dd4", head)).toBe(head);
    expect(canonicalLgtmShaForHead("abc123", head)).toBe("abc123");
  });

  it("finds terminal reviewer and merge events from the journal", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { t: "2026-06-11T00:01:00.000Z", event: "merged", sha: "head456", by: "javi" },
      { t: "2026-06-11T00:02:00.000Z", event: "combo_closed" },
    ] satisfies ComboEvent[];

    expect(terminalReviewerEvent(events)).toMatchObject({ event: "combo_closed" });
    expect(hasMergedEvent(events, ["squash789", "head456"])).toBe(true);
    expect(hasMergedEvent(events, ["squash789"])).toBe(false);
  });
});
