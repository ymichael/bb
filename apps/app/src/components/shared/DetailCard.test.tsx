import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailCard, DetailRow } from "@bb/ui-core";

describe("DetailCard", () => {
  it("renders rows inline as a two-column key/value layout when using columns", () => {
    const markup = renderToStaticMarkup(
      <DetailCard layout="columns">
        <DetailRow label="Workflow">Ready</DetailRow>
      </DetailCard>,
    );

    expect(markup).toContain("<dl");
    expect(markup).toContain(">Workflow</dt><dd");
    expect(markup).not.toContain("<div");
  });

  it("keeps the default stacked row wrapper layout", () => {
    const markup = renderToStaticMarkup(
      <DetailCard>
        <DetailRow label="Workflow">Ready</DetailRow>
      </DetailCard>,
    );

    expect(markup).toContain("<dl");
    expect(markup).toContain("<div");
    expect(markup).toContain(">Workflow</dt>");
  });

  it("renders vertical rows as a single-column label/value block", () => {
    const markup = renderToStaticMarkup(
      <DetailCard>
        <DetailRow label="Changed files" layout="vertical">
          src/example.ts
        </DetailRow>
      </DetailCard>,
    );

    expect(markup).toContain("<div");
    expect(markup).toContain(">Changed files</dt>");
    expect(markup).toContain(">src/example.ts</dd>");
  });
});
