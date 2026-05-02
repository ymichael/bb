// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTimelineExpansionState } from "../src/thread-timeline/useTimelineExpansionState.js";

interface ExpansionProbeProps {
  autoExpandedRowIds: ReadonlySet<string>;
  rowIds: ReadonlySet<string>;
}

function ExpansionProbe({
  autoExpandedRowIds,
  rowIds,
}: ExpansionProbeProps) {
  const expansion = useTimelineExpansionState({
    autoExpandedRowIds,
    rowIds,
  });
  const rowId = "row-1";
  return (
    <button type="button" onClick={() => expansion.toggle(rowId)}>
      {expansion.isExpanded(rowId) ? "expanded" : "collapsed"}
    </button>
  );
}

afterEach(() => {
  cleanup();
});

describe("useTimelineExpansionState", () => {
  it("keeps manual collapse across rerenders when automatic expansion still applies", () => {
    const rowIds = new Set(["row-1"]);
    const autoExpandedRowIds = new Set(["row-1"]);
    const view = render(
      <ExpansionProbe
        autoExpandedRowIds={autoExpandedRowIds}
        rowIds={rowIds}
      />,
    );

    expect(screen.getByRole("button").textContent).toBe("expanded");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("collapsed");

    view.rerender(
      <ExpansionProbe
        autoExpandedRowIds={new Set(["row-1"])}
        rowIds={new Set(["row-1"])}
      />,
    );

    expect(screen.getByRole("button").textContent).toBe("collapsed");
  });
});
