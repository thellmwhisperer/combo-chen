/**
 * @overview Ink/React TUI home (fleet view) per PRD §8 surface 2. Renders
 *   capsules sorted needs-you-first, filter tabs, per-row detail lines, and
 *   first-class empty states. The component is a thin shell: navigation logic
 *   lives in navigation.ts (pure, tested), fleet data in fleet-fold.ts (pure,
 *   tested). Frozen design rules: no progress bars (count-up timer + spinner),
 *   numbers always labeled with a verb.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at Home               <- the top-level component wiring.
 *   2. Then FleetBody              <- rows + empty states rendering.
 *   3. Then DiveStub               <- placeholder panel for a selected combo.
 *
 *   MAIN FLOW
 *   ---------
 *   FleetRow[] -> deriveFleetView -> <FleetBody> -> rendered output
 *   keyboard -> useInput -> navigate(state, input) -> re-render
 *
 *   PUBLIC API
 *   ----------
 *   Home        The fleet view Ink component.
 *
 *   INTERNALS
 *   ---------
 *   FleetBody, FleetRowView, DiveStub, OnboardingScreen, AllQuietScreen,
 *   phaseGlyph, phaseColor.
 *
 * @exports Home
 * @deps ink, react, ./fleet-fold, ./navigation
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

import {
  deriveFleetView,
  type FleetRenderPhase,
  type FleetRow,
} from "./fleet-fold.js";
import { initialNavState, navigate, type NavState } from "./navigation.js";

// -- 1/4 HELPER · phase rendering facts --
const PHASE_GLYPH: Record<FleetRenderPhase, string> = {
  CODER: "\u25B6",
  REVIEW: "\u25B6",
  GATE: "\u25B6",
  PR: "\u25B6",
  READY: "\u2713",
  NEEDS_YOU: "\u2691",
  PARKED: "\u25A0",
  CLOSED: "\u2713",
};

const PHASE_COLOR: Record<FleetRenderPhase, string> = {
  CODER: "green",
  REVIEW: "yellow",
  GATE: "yellow",
  PR: "yellow",
  READY: "green",
  NEEDS_YOU: "red",
  PARKED: "gray",
  CLOSED: "gray",
};
// -/ 1/4

// -- 2/4 CORE · Home <-
export function Home({ rows }: { readonly rows: readonly FleetRow[] }): React.ReactElement {
  const { exit } = useApp();
  const [nav, setNav] = useState<NavState>(initialNavState);
  const navRef = useRef(nav);
  navRef.current = nav;

  const view = deriveFleetView({ rows, tab: nav.tab });

  useInput((input, key) => {
    const currentRows = deriveFleetView({ rows, tab: navRef.current.tab }).rows;
    const next = navigate(
      navRef.current,
      {
        input,
        ...(key.upArrow ? { upArrow: true } : {}),
        ...(key.downArrow ? { downArrow: true } : {}),
        ...(key.leftArrow ? { leftArrow: true } : {}),
        ...(key.rightArrow ? { rightArrow: true } : {}),
        ...(key.return ? { return: true } : {}),
        ...(key.escape ? { escape: true } : {}),
      },
      currentRows,
    );
    navRef.current = next;
    setNav(next);
  });

  useEffect(() => {
    if (nav.shouldExit) exit();
  }, [nav.shouldExit, exit]);

  if (nav.diveComboId !== null) {
    return <DiveStub comboId={nav.diveComboId} rows={rows} />;
  }
  return <FleetBody view={view} selected={nav.selected} />;
}
// -/ 2/4

// -- 3/4 CORE · FleetBody + rows + empty states <-
function FleetBody({
  view,
  selected,
}: {
  readonly view: ReturnType<typeof deriveFleetView>;
  readonly selected: number;
}): React.ReactElement {
  if (view.emptyState === "onboarding") return <OnboardingScreen />;
  if (view.emptyState === "all-quiet") return <AllQuietScreen />;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="magenta">combo-chen</Text>
        <Text dimColor> · fleet </Text>
        {view.needsCount > 0 ? (
          <Text color="red">
            {"● "}
            {view.needsCount} need{view.needsCount === 1 ? "" : "s"} you
          </Text>
        ) : (
          <Text color="green">● all quiet</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          [1] live{view.tab === "live" ? " ●" : ""}  [2] parked{view.tab === "parked" ? " ●" : ""}{" "}
          [3] closed{view.tab === "closed" ? " ●" : ""}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {view.rows.map((row, i) => (
          <FleetRowView key={row.comboId} row={row} selected={i === selected} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"↑↓ select · Enter dive · 1-3 tabs · q quit"}</Text>
      </Box>
    </Box>
  );
}

function FleetRowView({
  row,
  selected,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
}): React.ReactElement {
  const glyph = PHASE_GLYPH[row.renderPhase];
  const color = PHASE_COLOR[row.renderPhase];
  const marker = selected ? "❯" : " ";
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={selected ? color : undefined}>{marker} </Text>
        <Text>
          <Text color={color}>
            {glyph} {row.renderPhase}
          </Text>{" "}
          {row.workItemLabel}
        </Text>
        <Box marginLeft={2}>
          <Text dimColor>{row.lastActivityLabel} ago</Text>
        </Box>
      </Box>
      <Box marginLeft={4}>
        <Text dimColor>{row.detailLine}</Text>
      </Box>
    </Box>
  );
}
// -/ 3/4

// -- 4/4 HELPER · empty states + dive stub --
function OnboardingScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">combo-chen</Text>
        <Text dimColor> · no combos yet</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>Start one:</Text>
        <Text color="green">{"  combo-chen run --issue <url>"}</Text>
        <Text dimColor>{"  (or --plan <file>)"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>q quit</Text>
      </Box>
    </Box>
  );
}

function AllQuietScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">combo-chen</Text>
        <Text dimColor> · </Text>
        <Text color="green">all quiet, nothing needs you</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"↑↓ select · Enter dive · 1-3 tabs · q quit"}</Text>
      </Box>
    </Box>
  );
}

function DiveStub({
  comboId,
  rows,
}: {
  readonly comboId: string;
  readonly rows: readonly FleetRow[];
}): React.ReactElement {
  const row = rows.find((r) => r.comboId === comboId);
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">{comboId}</Text>
        {row !== undefined && (
          <>
            <Text dimColor> · </Text>
            <Text>{row.workItemLabel}</Text>
          </>
        )}
      </Box>
      {row !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={PHASE_COLOR[row.renderPhase]}>
              {PHASE_GLYPH[row.renderPhase]} {row.renderPhase}
            </Text>
          </Text>
          <Text dimColor>{row.detailLine}</Text>
          {row.prUrl !== undefined && <Text dimColor>PR: {row.prUrl}</Text>}
          <Text dimColor>round {row.round}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>dive-in threading is a later task · q/←/Esc back to fleet</Text>
      </Box>
    </Box>
  );
}
// -/ 4/4
