// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilePathLink } from "@/components/ui/file-path-link";

afterEach(() => {
  cleanup();
});

describe("FilePathLink", () => {
  it("renders as a non-interactive span when no onClick is provided", () => {
    render(<FilePathLink path="src/foo.ts" />);

    expect(screen.queryByRole("button")).toBeNull();
    const span = screen.getByTitle("src/foo.ts");
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toContain("src/foo.ts");
  });

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

    expect(container.querySelector(".lucide-external-link")).not.toBeNull();
  });

  it("does not render the external-link icon when no variant is set", () => {
    const { container } = render(
      <FilePathLink path="src/foo.ts" onClick={() => {}} />,
    );

    expect(container.querySelector(".lucide-external-link")).toBeNull();
  });

  it("does not render the external-link icon when variant=external but no onClick (no action available)", () => {
    const { container } = render(
      <FilePathLink path="src/foo.ts" variant="external" />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".lucide-external-link")).toBeNull();
  });

  it("uses displayName for visible text and path for the tooltip", () => {
    render(<FilePathLink path="src/full/path.ts" displayName="path.ts" />);

    const node = screen.getByTitle("src/full/path.ts");
    expect(node.textContent).toContain("path.ts");
    expect(node.textContent).not.toContain("src/full/path.ts");
  });
});
