/**
 * @overview Pure tmux jump action builder for the dive-in Enter key (PRD s8).
 *   Maps the live actor to its topology window name and composes the tmux
 *   arg vectors that move the client onto that window, plus the prefix-B
 *   return binding to come back to the home session. The TUI only emits these
 *   arg vectors via deps.tmux; it never sends keys into, or reads panes from,
 *   the actor window.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at jumpToActorActions  <- (inside, session, actor, home) -> arg[][].
 *   2. Then actorWindowName          <- actor -> topology window name.
 *
 *   MAIN FLOW
 *   ---------
 *   dive-in Enter -> live actor -> jumpToActorActions -> deps.tmux per vector
 *
 *   PUBLIC API
 *   ----------
 *   JumpActor          coder | reviewer | gate.
 *   JumpInput          what the jump needs to know.
 *   actorWindowName    actor -> topology window name.
 *   jumpToActorActions pure: JumpInput -> tmux arg[][] (empty when unreachable).
 *
 *   INTERNALS
 *   ---------
 *   none.
 *
 * @exports JumpActor, JumpInput, actorWindowName, jumpToActorActions
 * @deps ../../infra/tmux
 */
import { attachSessionArgs, bindKeyArgs, selectWindowArgs, switchClientArgs } from "../../infra/tmux.js";

// -- 1/2 CORE · types + actorWindowName <- START HERE --
export type JumpActor = "coder" | "reviewer" | "gate";

export interface JumpInput {
  readonly insideTmux: boolean;
  readonly comboSession: string;
  readonly actor: JumpActor;
  readonly homeSession: string;
}

/**
 * Maps an actor to its window name in the combo tmux topology. The coder and
 * reviewer windows are the stable CODER_WINDOW/REVIEWER_WINDOW contract; the
 * gate actor lands on the persistent gatekeeper window where the gate is
 * attachable. Window names are the topology contract pinned in
 * src/app/runtime/sessions.ts and src/app/gate/gate.ts.
 */
export function actorWindowName(actor: JumpActor): string {
  switch (actor) {
    case "coder":
      return "coder";
    case "reviewer":
      return "reviewer";
    case "gate":
      return "gatekeeper";
  }
}
// -/ 1/2

// -- 2/2 CORE · jumpToActorActions --
/**
 * Composes the tmux arg vectors that move the client onto the live actor's
 * window and bind prefix-B to return home. Order is bind -> select -> switch
 * (inside tmux) or bind -> select -> attach (outside): the select lands before
 * the client move so the combo session's active window is the actor window.
 * Returns an empty list when the combo session is unreachable.
 */
export function jumpToActorActions(input: JumpInput): string[][] {
  if (input.comboSession === "") return [];
  const window = actorWindowName(input.actor);
  const bindReturn = bindKeyArgs("B", `switch-client -t ${input.homeSession}`);
  const select = selectWindowArgs(input.comboSession, window);
  const connect = input.insideTmux
    ? switchClientArgs(input.comboSession)
    : attachSessionArgs(input.comboSession);
  return [bindReturn, select, connect];
}
// -/ 2/2
