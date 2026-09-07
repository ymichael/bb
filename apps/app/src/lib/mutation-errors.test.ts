import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./api";
import {
  getMutationErrorMessage,
  getMutationErrorMeta,
  shouldShowMutationErrorToast,
  showMutationErrorToast,
} from "./mutation-errors";

interface CapturedToastProps {
  description?: ReactNode;
  title: ReactNode;
  tone: string;
}

interface CapturedToastOptions {
  id: string;
}

interface SonnerCustomOptions {
  id?: string | number;
}

interface SonnerCustomToast {
  options: CapturedToastOptions;
  renderToast: (id: string | number) => ReactElement;
}

const mutationToastState = vi.hoisted(() => {
  const invocations: SonnerCustomToast[] = [];
  return {
    custom: vi.fn(
      (
        renderToast: (id: string | number) => ReactElement,
        options?: SonnerCustomOptions,
      ) => {
        const fallbackId = `toast-${invocations.length + 1}`;
        const id =
          typeof options?.id === "string" || typeof options?.id === "number"
            ? String(options.id)
            : fallbackId;
        const toast = {
          options: { id },
          renderToast,
        };
        invocations.push(toast);
        return id;
      },
    ),
    dismiss: vi.fn(),
    invocations,
  };
});

vi.mock("sonner", () => ({
  toast: {
    custom: mutationToastState.custom,
    dismiss: mutationToastState.dismiss,
  },
}));

function readLatestToastProps(): CapturedToastProps {
  const invocation = mutationToastState.invocations.at(-1);
  if (!invocation) {
    throw new Error("Expected mutation error toast invocation.");
  }
  const element = invocation.renderToast(invocation.options.id);
  if (!isValidElement<CapturedToastProps>(element)) {
    throw new Error("Expected app toast content element.");
  }
  return element.props;
}

afterEach(() => {
  mutationToastState.invocations.splice(0);
  mutationToastState.custom.mockClear();
  mutationToastState.dismiss.mockClear();
});

describe("getMutationErrorMeta", () => {
  it("reads supported fields from mutation meta", () => {
    expect(
      getMutationErrorMeta({
        errorMessage: " Failed to update thread. ",
        lifecycleOperation: "send_message",
        showErrorToast: false,
      }),
    ).toEqual({
      errorMessage: "Failed to update thread.",
      lifecycleOperation: "send_message",
      showErrorToast: false,
    });
  });

  it("ignores unsupported meta shapes", () => {
    expect(
      getMutationErrorMeta({
        errorMessage: 123,
        lifecycleOperation: "nope",
        showErrorToast: "nope",
      }),
    ).toEqual({});
    expect(getMutationErrorMeta(undefined)).toEqual({});
  });

  it("uses lifecycle error descriptions before raw server messages", () => {
    const lifecycleError = new HttpError({
      body: {
        code: "thread_not_writable",
        message: "Thread is not active",
        details: {
          archivedAt: null,
          reason: "not_started",
          threadStatus: "starting",
        },
      },
      code: "thread_not_writable",
      message: "Thread is not active",
      status: 409,
    });

    expect(
      getMutationErrorMessage({
        error: lifecycleError,
        fallbackMessage: "Failed to send message.",
        lifecycleOperation: "send_message",
      }),
    ).toBe("Failed to send message. The thread is still starting.");
  });
});

describe("getMutationErrorMessage", () => {
  it("uses explicit server messages before falling back to normalized transport messages", () => {
    const contractError = new HttpError({
      body: {
        code: "invalid_request",
        message: "Environment unavailable",
      },
      code: "invalid_request",
      message: "Environment unavailable",
      status: 409,
    });

    expect(
      getMutationErrorMessage({
        error: contractError,
        fallbackMessage: "Request failed.",
      }),
    ).toBe("Environment unavailable");
    expect(
      getMutationErrorMessage({
        error: new TypeError("Failed to fetch"),
        fallbackMessage: "Request failed.",
      }),
    ).toBe(
      "Could not reach the server. Check that it is running and try again.",
    );

    const fallbackHttpError = new HttpError({
      code: "invalid_request",
      message: "Commit failed",
      status: 409,
    });

    expect(
      getMutationErrorMessage({
        error: fallbackHttpError,
        fallbackMessage: "Request failed.",
      }),
    ).toBe("Commit failed");
  });
});

describe("shouldShowMutationErrorToast", () => {
  it("suppresses abort-like errors", () => {
    expect(
      shouldShowMutationErrorToast(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
    ).toBe(false);
    expect(shouldShowMutationErrorToast({ name: "AbortError" })).toBe(false);
  });
});

describe("showMutationErrorToast", () => {
  it("splits the generic mutation fallback into title and description", () => {
    showMutationErrorToast({
      error: {},
      fallbackMessage: "Request failed.",
    });

    const props = readLatestToastProps();
    expect(props.tone).toBe("error");
    expect(props.title).toBe("Request failed");
    expect(props.description).toBe("Please try again");
  });

  it("strips trailing periods from fallback toast titles", () => {
    showMutationErrorToast({
      error: {},
      fallbackMessage: "Failed to update thread.",
    });

    const props = readLatestToastProps();
    expect(props.tone).toBe("error");
    expect(props.title).toBe("Failed to update thread");
    expect(props.description).toBeUndefined();
  });
});
