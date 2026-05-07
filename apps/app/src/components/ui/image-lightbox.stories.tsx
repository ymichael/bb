import { useState } from "react";
import ghosttyIcon from "@/assets/workspace-open-target-icons/ghostty.png";
import vscodeIcon from "@/assets/workspace-open-target-icons/vscode.png";
import zedIcon from "@/assets/workspace-open-target-icons/zed.png";
import { ImageLightbox } from "./image-lightbox";

export default {
  title: "Primitives/ImageLightbox",
};

const galleryImages: readonly GalleryImage[] = [
  {
    alt: "VS Code app icon",
    src: vscodeIcon,
    title: "VS Code",
  },
  {
    alt: "Zed app icon",
    src: zedIcon,
    title: "Zed",
  },
  {
    alt: "Ghostty app icon",
    src: ghosttyIcon,
    title: "Ghostty",
  },
];

export function SingleImage() {
  return (
    <div className="min-h-[28rem] p-6">
      <ImageLightbox
        imageAlt="VS Code app icon"
        imageSrc={vscodeIcon}
        onClose={ignoreClose}
        title="Workspace target preview"
      />
    </div>
  );
}

export function GalleryNavigation() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const image = galleryImages[currentIndex];

  return (
    <div className="min-h-[28rem] p-6">
      <ImageLightbox
        hasMultipleImages
        imageAlt={image.alt}
        imageSrc={image.src}
        onClose={ignoreClose}
        onNext={() =>
          setCurrentIndex((index) =>
            index === galleryImages.length - 1 ? 0 : index + 1,
          )
        }
        onPrevious={() =>
          setCurrentIndex((index) =>
            index === 0 ? galleryImages.length - 1 : index - 1,
          )
        }
        title={image.title}
      />
    </div>
  );
}

export function ClosedState() {
  return (
    <div className="grid min-h-40 place-items-center p-6 text-sm text-muted-foreground">
      <ImageLightbox
        imageAlt="No image selected"
        imageSrc={null}
        onClose={ignoreClose}
        title="No preview"
      />
      No preview open
    </div>
  );
}

interface GalleryImage {
  alt: string;
  src: string;
  title: string;
}

function ignoreClose(): void {}
