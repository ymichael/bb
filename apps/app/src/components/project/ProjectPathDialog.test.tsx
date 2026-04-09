// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ProjectPathDialog } from "./ProjectPathDialog"

describe("ProjectPathDialog", () => {
  it("keeps validation errors visible until the path changes", async () => {
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        pickFolder={null}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )

    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "relative/path" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))

    screen.getByText("Project path must be an absolute Linux or WSL path.")

    await waitFor(() => {
      screen.getByText("Project path must be an absolute Linux or WSL path.")
    })

    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/srv/repos/demo" },
    })

    await waitFor(() => {
      expect(
        screen.queryByText("Project path must be an absolute Linux or WSL path."),
      ).toBeNull()
    })
  })

  it("shows the native folder picker button only when the host supports it", () => {
    const { rerender } = render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        pickFolder={null}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )

    expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull()

    rerender(
      <ProjectPathDialog
        target={{ kind: "create" }}
        pickFolder={async () => "/srv/repos/demo"}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )

    screen.getByRole("button", { name: "Choose folder" })
  })

  it("normalizes picked folder paths before showing them", async () => {
    const pickFolder = vi.fn(async () => "/srv/repos/demo/")

    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        pickFolder={pickFolder}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }))

    await waitFor(() => {
      screen.getByDisplayValue("/srv/repos/demo")
    })
    expect(pickFolder).toHaveBeenCalledTimes(1)
  })
})
