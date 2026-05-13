// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilePathLink } from "@/components/ui/file-path-link";

afterEach(() => {
  cleanup();
});

describe("FilePathLink", () => {
  it("invokes onClick when the button is clicked", () => {
    const onClick = vi.fn();
    render(<FilePathLink path="src/foo.ts" onClick={onClick} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the external-link icon suffix when variant=external and onClick is set", () => {
    const { container } = render(
      <FilePathLink path="src/foo.ts" onClick={() => {}} variant="external" />,
    );

    expect(container.querySelector('[data-icon="ExternalLink"]')).not.toBeNull();
  });

  it("does not render the external-link icon when no variant is set", () => {
    const { container } = render(
      <FilePathLink path="src/foo.ts" onClick={() => {}} />,
    );

    expect(container.querySelector('[data-icon="ExternalLink"]')).toBeNull();
  });

  it("does not render the external-link icon when variant=external but no onClick (no action available)", () => {
    const { container } = render(
      <FilePathLink path="src/foo.ts" variant="external" />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-icon="ExternalLink"]')).toBeNull();
  });
});
