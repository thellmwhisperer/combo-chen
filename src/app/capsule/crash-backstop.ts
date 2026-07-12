/**
 * @overview Synchronous terminal journaling for capsule process failures.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at installCapsuleCrashBackstop <- installs both fatal Node signal handlers.
 *   2. Use record                         <- catches action-level rejections before Commander.
 *
 *   MAIN FLOW
 *   ---------
 *   fatal signal or caught rejection -> append capsule_crashed -> process termination
 *
 *   PUBLIC API
 *   ----------
 *   CapsuleCrashBackstop         Recorder and listener cleanup handle.
 *   installCapsuleCrashBackstop  Install synchronous crash journaling for one run directory.
 *
 *   INTERNALS
 *   ---------
 *   crashReason
 *
 * @exports CapsuleCrashBackstop, installCapsuleCrashBackstop
 * @deps node:{events,process}, ../../core/events
 */
import type { EventEmitter } from "node:events";

import { appendEvent } from "../../core/events.js";

export interface CapsuleCrashBackstop {
  record: (reason: unknown, origin: string) => boolean;
  dispose: () => void;
}

interface CrashBackstopOptions {
  runtime?: Pick<EventEmitter, "on" | "removeListener">;
  terminate?: (code: number) => void;
}

// -- 1/1 CORE · installCapsuleCrashBackstop <- START HERE --
function crashReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function installCapsuleCrashBackstop(
  runDir: string,
  options: CrashBackstopOptions = {},
): CapsuleCrashBackstop {
  const runtime = options.runtime ?? process;
  const terminate = options.terminate ?? ((code: number) => process.exit(code));
  let recorded = false;
  const record = (reason: unknown, origin: string): boolean => {
    if (recorded) return false;
    recorded = true;
    appendEvent(runDir, "capsule_crashed", { reason: crashReason(reason), origin });
    return true;
  };
  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    if (record(error, origin)) terminate(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    if (record(reason, "unhandledRejection")) terminate(1);
  };
  runtime.on("uncaughtException", onUncaughtException);
  runtime.on("unhandledRejection", onUnhandledRejection);
  return {
    record,
    dispose: () => {
      runtime.removeListener("uncaughtException", onUncaughtException);
      runtime.removeListener("unhandledRejection", onUnhandledRejection);
    },
  };
}
// -/ 1/1
