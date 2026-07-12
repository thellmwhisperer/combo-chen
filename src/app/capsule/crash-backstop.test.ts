/**
 * @overview Process-level capsule crash journal backstop contract tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the crash signal test <- synchronous terminal journal guarantee.
 *
 *   MAIN FLOW
 *   ---------
 *   fake process signal -> installCapsuleCrashBackstop -> capsule_crashed -> terminate
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps node:{events,fs,os,path}, vitest, ../../core/events, ./crash-backstop
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { readEvents } from "../../core/events.js";
import { installCapsuleCrashBackstop } from "./crash-backstop.js";

// -- 1/1 CORE · terminal crash signal <- START HERE --
it("journals one terminal capsule_crashed event synchronously before termination", () => {
  const runDir = join(mkdtempSync(join(tmpdir(), "combo-chen-crash-backstop-")), "run");
  mkdirSync(runDir);
  const runtime = new EventEmitter();
  const terminate = vi.fn();
  const backstop = installCapsuleCrashBackstop(runDir, {
    runtime,
    terminate,
  });

  runtime.emit("unhandledRejection", new Error("gate driver lost"));
  runtime.emit("uncaughtException", new Error("secondary crash"), "uncaughtException");

  expect(readEvents(runDir)).toEqual([
    expect.objectContaining({
      event: "capsule_crashed",
      reason: "gate driver lost",
      origin: "unhandledRejection",
    }),
  ]);
  expect(terminate).toHaveBeenCalledOnce();
  expect(terminate).toHaveBeenCalledWith(1);
  backstop.dispose();
});
// -/ 1/1
