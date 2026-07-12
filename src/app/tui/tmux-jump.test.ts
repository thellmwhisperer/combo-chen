/**
 * @overview Pure tmux jump action builder tests: the dive-in Enter jump moves
 *   the client onto the live actor's window and binds prefix-B to return. The
 *   TUI only composes these arg vectors; it never sends keys or reads panes.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at actorWindowName   <- actor -> topology window name.
 *   2. Then jumpToActorActions    <- inside/outside tmux action composition.
 *
 *   MAIN FLOW
 *   ---------
 *   (inside, session, actor, home) -> jumpToActorActions -> tmux arg[][]
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./tmux-jump, vitest
 */
import { describe, expect, it } from "vitest";

import { actorWindowName, type JumpActor, jumpToActorActions, type JumpInput } from "./tmux-jump.js";

// -- 1/2 CORE · actorWindowName --
describe("actorWindowName", () => {
  it("maps each actor to its topology window name", () => {
    expect(actorWindowName("coder")).toBe("coder");
    expect(actorWindowName("reviewer")).toBe("reviewer");
    expect(actorWindowName("gate")).toBe("gatekeeper");
  });
});
// -/ 1/2

// -- 2/2 CORE · jumpToActorActions --
describe("jumpToActorActions", () => {
  const baseInside: JumpInput = {
    insideTmux: true,
    comboSession: "combo-chen-owner-repo-7",
    actor: "coder" as JumpActor,
    homeSession: "combo-chen-home",
  };

  it("returns empty actions when the combo session is empty", () => {
    expect(jumpToActorActions({ ...baseInside, comboSession: "" })).toEqual([]);
  });

  it("inside tmux: binds prefix-B to return home, selects the actor window, then switches the client", () => {
    const actions = jumpToActorActions(baseInside);
    expect(actions).toEqual([
      ["bind-key", "B", "switch-client", "-t", "combo-chen-home"],
      ["select-window", "-t", "combo-chen-owner-repo-7:coder"],
      ["switch-client", "-t", "combo-chen-owner-repo-7"],
    ]);
  });

  it("targets the reviewer window for the reviewer actor", () => {
    const actions = jumpToActorActions({ ...baseInside, actor: "reviewer" });
    const select = actions[1]!;
    expect(select).toEqual(["select-window", "-t", "combo-chen-owner-repo-7:reviewer"]);
  });

  it("targets the gatekeeper window for the gate actor", () => {
    const actions = jumpToActorActions({ ...baseInside, actor: "gate" });
    const select = actions[1]!;
    expect(select).toEqual(["select-window", "-t", "combo-chen-owner-repo-7:gatekeeper"]);
  });

  it("outside tmux: binds the return key then attaches to the combo session", () => {
    const actions = jumpToActorActions({ ...baseInside, insideTmux: false });
    expect(actions).toEqual([
      ["bind-key", "B", "switch-client", "-t", "combo-chen-home"],
      ["select-window", "-t", "combo-chen-owner-repo-7:coder"],
      ["attach", "-t", "combo-chen-owner-repo-7"],
    ]);
  });

  it("order is bind -> select -> switch/attach so the client lands on the actor window", () => {
    const inside = jumpToActorActions(baseInside).map((a) => a[0]);
    expect(inside).toEqual(["bind-key", "select-window", "switch-client"]);
    const outside = jumpToActorActions({ ...baseInside, insideTmux: false }).map((a) => a[0]);
    expect(outside).toEqual(["bind-key", "select-window", "attach"]);
  });
});
// -/ 2/2
