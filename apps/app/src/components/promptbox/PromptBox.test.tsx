import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PromptBox } from "./PromptBox"

describe("PromptBox", () => {
  it("shows stop while running when input is empty", () => {
    const html = renderToStaticMarkup(
      <PromptBox
        value="   "
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        onStop={vi.fn()}
      />
    )

    expect(html).toContain('title="Stop run"')
    expect(html).toContain("lucide-square")
    expect(html).not.toContain('title="Submit (Enter)"')
    expect(html).not.toContain("lucide-corner-down-left")
  })

  it("shows submit while running when input has content", () => {
    const html = renderToStaticMarkup(
      <PromptBox
        value="Keep going with these edits"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        isRunning
        onStop={vi.fn()}
      />
    )

    expect(html).toContain('title="Submit (Enter)"')
    expect(html).toContain("lucide-corner-down-left")
    expect(html).not.toContain('title="Stop run"')
    expect(html).not.toContain("lucide-square")
  })

  it("renders image attachment previews using the project attachment endpoint", () => {
    const html = renderToStaticMarkup(
      <PromptBox
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        attachments={[
          {
            type: "localImage",
            path: "/Users/me/.beanbag/attachments/proj-1/example.png",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 1024,
          },
        ]}
        attachmentProjectId="proj-1"
      />
    )

    expect(html).toContain(
      '/api/v1/projects/proj-1/attachments/content?path=%2FUsers%2Fme%2F.beanbag%2Fattachments%2Fproj-1%2Fexample.png'
    )
    expect(html).toContain('alt="example.png"')
  })
})
