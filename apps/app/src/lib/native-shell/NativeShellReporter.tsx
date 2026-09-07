import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { shellReportPath, shellReportReady, useNativeShell } from ".";

export function NativeShellReporter() {
  const shell = useNativeShell();
  const location = useLocation();
  const path = `${location.pathname}${location.search}`;
  const hasReportedReady = useRef(false);

  useEffect(() => {
    if (shell === null || hasReportedReady.current) return;
    hasReportedReady.current = true;
    shellReportReady(path);
  }, [path, shell]);

  useEffect(() => {
    if (shell === null) return;
    shellReportPath(document.title, path);
  }, [path, shell]);

  return null;
}
