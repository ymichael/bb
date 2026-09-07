import { ipcRenderer } from "electron";
import {
  BB_DESKTOP_EXISTING_SERVER_DIALOG_CHOOSE_CHANNEL,
  EXISTING_SERVER_DIALOG_CHOICES,
  type ExistingServerDialogChooseRequest,
} from "./existing-server-dialog-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  function choose(choice: ExistingServerDialogChooseRequest["choice"]): void {
    ipcRenderer.send(BB_DESKTOP_EXISTING_SERVER_DIALOG_CHOOSE_CHANNEL, {
      choice,
    });
  }

  for (const choice of EXISTING_SERVER_DIALOG_CHOICES) {
    const button = document.querySelector<HTMLButtonElement>(
      `button[data-choice="${choice}"]`,
    );
    button?.addEventListener("click", () => {
      choose(choice);
    });
  }

  document
    .querySelector<HTMLButtonElement>('button[data-choice="connect"]')
    ?.focus();

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      choose("quit");
    }
  });
});
