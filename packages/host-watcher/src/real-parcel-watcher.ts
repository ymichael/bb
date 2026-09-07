import parcelWatcher from "@parcel/watcher";
import type { ParcelWatcherBackend } from "./parcel-watcher-backend.js";

export const realParcelWatcher: ParcelWatcherBackend = parcelWatcher;
