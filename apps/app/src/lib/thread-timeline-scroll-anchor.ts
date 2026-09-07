import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export interface ScrollAnchor {
  rowId: string;
  offsetWithinRow: number;
  atBottom: boolean;
}

export const threadTimelineScrollAnchorAtomFamily = atomFamily(
  (_threadId: string) => atom<ScrollAnchor | null>(null),
);
