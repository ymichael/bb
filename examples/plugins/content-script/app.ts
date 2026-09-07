import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"]';
const ACTIVE_CLASS = "content-script-example-active";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "editable-focus-ring",
    mount({ signal }) {
      const marked = new Set<HTMLElement>();

      const mark = (target: EventTarget | null) => {
        if (!(target instanceof HTMLElement)) return;
        const editable = target.closest<HTMLElement>(EDITABLE_SELECTOR);
        if (editable === null) return;
        editable.classList.add(ACTIVE_CLASS);
        marked.add(editable);
      };
      const unmark = (target: EventTarget | null) => {
        if (!(target instanceof HTMLElement)) return;
        const editable = target.closest<HTMLElement>(EDITABLE_SELECTOR);
        if (editable === null) return;
        editable.classList.remove(ACTIVE_CLASS);
        marked.delete(editable);
      };
      const clear = () => {
        document.removeEventListener("focusin", onFocusIn);
        document.removeEventListener("focusout", onFocusOut);
        for (const editable of marked) editable.classList.remove(ACTIVE_CLASS);
        marked.clear();
      };
      const onFocusIn = (event: FocusEvent) => mark(event.target);
      const onFocusOut = (event: FocusEvent) => unmark(event.target);

      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);
      mark(document.activeElement);
      signal.addEventListener("abort", clear, { once: true });

      return clear;
    },
  });
});
