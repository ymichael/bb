import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { AppToastTone } from "@/components/ui/app-toast";

export interface AppNotification {
  id: string;
  toastId: string | number | null;
  tone: AppToastTone;
  title: ReactNode;
  description: ReactNode | null;
  createdAt: number;
}

export interface NotificationCenterState {
  open: boolean;
  focusedId: string | null;
}

export interface RecordNotificationParams {
  toastId: string | number | null;
  tone: AppToastTone;
  title: ReactNode;
  description: ReactNode | null;
  createdAt: number;
}

const MAX_NOTIFICATIONS = 200;
const CLOSED_STATE: NotificationCenterState = { open: false, focusedId: null };

let notifications: readonly AppNotification[] = [];
let centerState: NotificationCenterState = CLOSED_STATE;
let nextSequence = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordNotification(params: RecordNotificationParams): string {
  const existingIndex =
    params.toastId === null
      ? -1
      : notifications.findIndex(
          (notification) => notification.toastId === params.toastId,
        );

  if (existingIndex !== -1) {
    const existing = notifications[existingIndex] as AppNotification;
    const next = notifications.slice();
    next[existingIndex] = {
      ...existing,
      tone: params.tone,
      title: params.title,
      description: params.description,
      createdAt: params.createdAt,
    };
    notifications = next;
    emit();
    return existing.id;
  }

  const id = `notification-${nextSequence}`;
  nextSequence += 1;
  notifications = [
    {
      id,
      toastId: params.toastId,
      tone: params.tone,
      title: params.title,
      description: params.description,
      createdAt: params.createdAt,
    },
    ...notifications,
  ].slice(0, MAX_NOTIFICATIONS);
  emit();
  return id;
}

export function dismissNotification(id: string): void {
  const next = notifications.filter((notification) => notification.id !== id);
  if (next.length === notifications.length) {
    return;
  }
  notifications = next;
  if (centerState.focusedId === id) {
    centerState = { ...centerState, focusedId: null };
  }
  emit();
}

export function clearNotifications(): void {
  if (notifications.length === 0) {
    return;
  }
  notifications = [];
  centerState = { ...centerState, focusedId: null };
  emit();
}

export function openNotificationCenter(focusedId: string | null = null): void {
  centerState = { open: true, focusedId };
  emit();
}

export function closeNotificationCenter(): void {
  if (!centerState.open && centerState.focusedId === null) {
    return;
  }
  centerState = CLOSED_STATE;
  emit();
}

export function toggleNotificationCenter(): void {
  if (centerState.open) {
    closeNotificationCenter();
    return;
  }
  openNotificationCenter();
}

export function resetNotificationStore(): void {
  notifications = [];
  centerState = CLOSED_STATE;
  nextSequence = 0;
  emit();
}

export function getNotifications(): readonly AppNotification[] {
  return notifications;
}

export function getNotificationCenterState(): NotificationCenterState {
  return centerState;
}

export function useNotifications(): readonly AppNotification[] {
  return useSyncExternalStore(
    subscribe,
    getNotifications,
    getNotifications,
  );
}

export function useNotificationCenterState(): NotificationCenterState {
  return useSyncExternalStore(
    subscribe,
    getNotificationCenterState,
    getNotificationCenterState,
  );
}
