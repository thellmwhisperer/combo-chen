#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = join(process.cwd(), ".gnhf", "runs", "e2e");
mkdirSync(runDir, { recursive: true });
writeFileSync(
  join(runDir, "iteration-1.jsonl"),
  `${JSON.stringify({ type: "thread.started", thread_id: "019eeee0-0000-7000-8000-000000000001" })}\n`,
);
