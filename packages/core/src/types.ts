// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

// Thread
export type ThreadStatus =
  | "created"
  | "provisioning"
  | "provisioning_failed"
  | "idle"
  | "active";

export interface Thread {
  id: string;
  projectId: string;
  title?: string;
  status: ThreadStatus;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

// Event (streaming log from codex)
export interface ThreadEvent {
  id: string;
  threadId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: number;
}
