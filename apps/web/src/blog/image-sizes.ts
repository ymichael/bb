type ImageSize = { width: number; height: number };

const IMAGE_SIZES: Record<string, ImageSize> = {
  "/blog/an-agentic-ide-that-builds-itself/header.png": {
    width: 680,
    height: 272,
  },
  "/blog/an-agentic-ide-that-builds-itself/first-open.jpg": {
    width: 1360,
    height: 919,
  },
  "/blog/an-agentic-ide-that-builds-itself/custom.jpg": {
    width: 1660,
    height: 1127,
  },
  "/blog/an-agentic-ide-that-builds-itself/daw.jpg": {
    width: 1200,
    height: 900,
  },
};

export function getImageSize(src: string): ImageSize | undefined {
  return IMAGE_SIZES[src];
}
