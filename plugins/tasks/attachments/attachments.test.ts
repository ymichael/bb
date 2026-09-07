import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import {
  buildAttachmentUrl,
  deleteAttachmentById,
  MAX_ATTACHMENT_SIZE_BYTES,
  registerAttachments,
} from ".";

function setup(options?: Parameters<typeof registerAttachments>[2]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
  const db = bb.storage.database();
  const store = createTasksStore(db);
  const project = store.createProject({
    name: "Attachments",
    prefix: "ATT",
    color: "blue",
  });
  const task = store.createTask({
    projectId: project.id,
    title: "Attachment owner",
  });
  registerAttachments(bb, store, options);
  const database = db
    .prepare<[], { name: string; file: string }>("PRAGMA database_list")
    .all()
    .find((entry) => entry.name === "main");
  if (!database) throw new Error("test database path is missing");
  return { bb, harness, store, task, root: dirname(database.file) };
}

async function upload(
  harness: ReturnType<typeof setup>["harness"],
  taskId: string,
  body: BodyInit,
  fileName = "image.png",
  mime = "image/png",
) {
  const query = new URLSearchParams({ taskId, fileName, mime });
  return harness.fetchHttp("POST", `/attachments/upload?${query}`, {
    body,
    headers: { "content-type": mime },
  });
}

describe("task attachments", () => {
  it("uploads a raw body into the plugin blob directory and creates its row", async () => {
    const { harness, root, store, task } = setup();
    try {
      const response = await upload(
        harness,
        task.id,
        new TextEncoder().encode("png bytes"),
        "../../unsafe.png",
      );
      expect(response.status).toBe(201);
      const result = (await response.json()) as {
        attachmentId: string;
        url: string;
      };
      const attachment = store.getAttachment(result.attachmentId);

      expect(result.url).toBe(buildAttachmentUrl(result.attachmentId));
      expect(attachment).toMatchObject({
        taskId: task.id,
        commentId: null,
        fileName: "unsafe.png",
        mime: "image/png",
        sizeBytes: 9,
        isImage: true,
      });
      expect(attachment?.blobPath).toBe(
        join("blobs", result.attachmentId, "unsafe.png"),
      );
      if (!attachment) throw new Error("attachment row was not created");
      expect(await readFile(join(root, attachment.blobPath), "utf8")).toBe(
        "png bytes",
      );
      expect(harness.realtimeSignals).toEqual([
        {
          channel: "tasks:changed",
          payload: { taskId: task.id, projectId: task.projectId },
        },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("rejects bodies larger than 25 MB without creating a row", async () => {
    const { harness, store, task } = setup();
    try {
      const response = await upload(
        harness,
        task.id,
        new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1),
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "attachment exceeds the 25 MB limit",
      });
      expect(store.listAttachmentsForTask(task.id)).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("requires exactly one task or comment owner", async () => {
    const { harness, task } = setup();
    try {
      const noOwner = await harness.fetchHttp(
        "POST",
        "/attachments/upload?fileName=a.txt&mime=text%2Fplain",
        { body: "hello", headers: { "content-type": "text/plain" } },
      );
      const twoOwners = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&commentId=comment&fileName=a.txt&mime=text%2Fplain`,
        { body: "hello", headers: { "content-type": "text/plain" } },
      );

      expect(noOwner.status).toBe(400);
      expect(twoOwners.status).toBe(400);
      await expect(noOwner.json()).resolves.toEqual({
        error: "exactly one of taskId or commentId is required",
      });
      await expect(twoOwners.json()).resolves.toEqual({
        error: "exactly one of taskId or commentId is required",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("downloads with image-aware headers", async () => {
    const { harness, task } = setup();
    try {
      const uploaded = await upload(
        harness,
        task.id,
        new TextEncoder().encode("image"),
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const response = await harness.fetchHttp(
        "GET",
        `/attachments/download?attachmentId=${attachmentId}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toBe(
        `inline; filename="image.png"; filename*=UTF-8''image.png`,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.text()).resolves.toBe("image");
    } finally {
      await harness.dispose();
    }
  });

  it("downloads a non-Latin-1 file name with an ASCII fallback in filename= (issue #1621)", async () => {
    const { harness, store, task } = setup();
    try {
      const emDashName = "report \u2014 final.txt";
      const uploaded = await upload(
        harness,
        task.id,
        new TextEncoder().encode("hello"),
        emDashName,
        "text/plain",
      );
      expect(uploaded.status).toBe(201);
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      expect(store.getAttachment(attachmentId)?.fileName).toBe(emDashName);

      const response = await harness.fetchHttp(
        "GET",
        `/attachments/download?attachmentId=${attachmentId}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="report - final.txt"; filename*=UTF-8''report%20%E2%80%94%20final.txt`,
      );
      await expect(response.text()).resolves.toBe("hello");
    } finally {
      await harness.dispose();
    }
  });

  it("percent-encodes every non attr-char in filename* (RFC 5987)", async () => {
    const { harness, task } = setup();
    try {
      const name = "\u5831\u544a (final)'.txt";
      const uploaded = await upload(
        harness,
        task.id,
        new TextEncoder().encode("hello"),
        name,
        "text/plain",
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const response = await harness.fetchHttp(
        "GET",
        `/attachments/download?attachmentId=${attachmentId}`,
      );

      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition");
      expect(disposition).toBe(
        `attachment; filename="-- (final)'.txt"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%20%28final%29%27.txt`,
      );
      const extValue = disposition?.split("filename*=UTF-8''")[1] ?? "";
      expect(extValue).toMatch(/^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})*$/);
      expect(decodeURIComponent(extValue)).toBe(name);
    } finally {
      await harness.dispose();
    }
  });

  it("strips Unicode bidirectional controls that could spoof the extension", async () => {
    const { harness, store, task } = setup();
    try {
      const uploaded = await upload(
        harness,
        task.id,
        new TextEncoder().encode("hello"),
        "photo\u202egnp.exe",
        "application/octet-stream",
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      expect(store.getAttachment(attachmentId)?.fileName).toBe("photo_gnp.exe");
      const response = await harness.fetchHttp(
        "GET",
        `/attachments/download?attachmentId=${attachmentId}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="photo_gnp.exe"; filename*=UTF-8''photo_gnp.exe`,
      );
    } finally {
      await harness.dispose();
    }
  });

  it("forces SVG downloads and never marks them as embeddable images", async () => {
    const { harness, store, task } = setup();
    try {
      const uploaded = await upload(
        harness,
        task.id,
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "active.svg",
        "image/svg+xml",
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };

      expect(store.getAttachment(attachmentId)).toMatchObject({
        mime: "image/svg+xml",
        isImage: false,
      });

      const downloaded = await harness.fetchHttp(
        "GET",
        `/attachments/download?attachmentId=${attachmentId}`,
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-disposition")).toBe(
        `attachment; filename="active.svg"; filename*=UTF-8''active.svg`,
      );
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await harness.dispose();
    }
  });

  it("deletes both the attachment row and blob directory", async () => {
    const { harness, root, store, task } = setup();
    try {
      const uploaded = await upload(
        harness,
        task.id,
        "document",
        "note.txt",
        "text/plain",
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const attachment = store.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      const blobDirectory = dirname(join(root, attachment.blobPath));

      const response = await harness.fetchHttp(
        "DELETE",
        `/attachments/delete?attachmentId=${attachmentId}`,
        { headers: { "content-type": "application/json" } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ deleted: true });
      expect(store.getAttachment(attachmentId)).toBeUndefined();
      await expect(stat(blobDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(harness.realtimeSignals).toEqual([
        {
          channel: "tasks:changed",
          payload: { taskId: task.id, projectId: task.projectId },
        },
        {
          channel: "tasks:changed",
          payload: { taskId: task.id, projectId: task.projectId },
        },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("deleteAttachmentById removes the row and blob and returns the attachment", async () => {
    const { bb, harness, root, store, task } = setup();
    try {
      const uploaded = await upload(
        harness,
        task.id,
        "document",
        "note.txt",
        "text/plain",
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const attachment = store.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      const blobDirectory = dirname(join(root, attachment.blobPath));

      const deleted = await deleteAttachmentById(bb, store, attachmentId);
      expect(deleted).toMatchObject({ id: attachmentId });
      expect(store.getAttachment(attachmentId)).toBeUndefined();
      await expect(stat(blobDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("keeps the row and blob reachable and publishes nothing when cleanup fails", async () => {
    const { harness, root, store, task } = setup({
      removeBlobs: async () => {
        throw new Error("simulated rm failure");
      },
    });
    try {
      const uploaded = await upload(harness, task.id, "image");
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const attachment = store.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      const description = `![diagram](${buildAttachmentUrl(attachmentId)})`;
      store.updateTask(task.id, { description });
      const signalsBeforeDelete = harness.realtimeSignals.length;

      const response = await harness.fetchHttp(
        "DELETE",
        `/attachments/delete?attachmentId=${attachmentId}&removeDescriptionReferences=true`,
        { headers: { "content-type": "application/json" } },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Failed to remove attachment blob: image.png",
      });
      expect(store.getAttachment(attachmentId)).toEqual(attachment);
      expect(store.getTask(task.id)?.description).toBe(description);
      await expect(
        readFile(join(root, attachment.blobPath), "utf8"),
      ).resolves.toBe("image");
      expect(harness.realtimeSignals).toHaveLength(signalsBeforeDelete);
    } finally {
      await harness.dispose();
    }
  });

  it("rejects deletion when the saved task description references the attachment", async () => {
    const { harness, root, store, task } = setup();
    try {
      const uploaded = await upload(harness, task.id, "image");
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const attachment = store.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      store.updateTask(task.id, {
        description: `![diagram](${buildAttachmentUrl(attachmentId)})`,
      });
      const signalsBeforeDelete = harness.realtimeSignals.length;

      const response = await harness.fetchHttp(
        "DELETE",
        `/attachments/delete?attachmentId=${attachmentId}`,
        { headers: { "content-type": "application/json" } },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error:
          'Attachment "image.png" is used in the task description. Remove it from the description before deleting the attachment.',
      });
      expect(store.getAttachment(attachmentId)).toEqual(attachment);
      await expect(
        readFile(join(root, attachment.blobPath), "utf8"),
      ).resolves.toBe("image");
      expect(harness.realtimeSignals).toHaveLength(signalsBeforeDelete);

      const confirmed = await harness.fetchHttp(
        "DELETE",
        `/attachments/delete?attachmentId=${attachmentId}&removeDescriptionReferences=true`,
        { headers: { "content-type": "application/json" } },
      );
      expect(confirmed.status).toBe(200);
      expect(store.getAttachment(attachmentId)).toBeUndefined();
      expect(store.getTask(task.id)?.description).toBe("");
      await expect(
        stat(dirname(join(root, attachment.blobPath))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(harness.realtimeSignals).toHaveLength(signalsBeforeDelete + 1);
    } finally {
      await harness.dispose();
    }
  });

  it("deleteAttachmentById is a safe no-op for an unknown id", async () => {
    const { bb, harness, store } = setup();
    try {
      await expect(
        deleteAttachmentById(bb, store, "01JZZZZZZZZZZZZZZZZZZZZZZZ"),
      ).resolves.toBeNull();
    } finally {
      await harness.dispose();
    }
  });
});
