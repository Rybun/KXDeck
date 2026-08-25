import { useEffect, useState } from "react";
import { applyAccent, DEFAULT_ACCENT } from "../lib/accent";

const STORAGE_KEY = "kxdeck.accent";

export function useAccent() {
  const [accent, setAccentState] = useState(() => localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT);

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  function setAccent(name: string) {
    localStorage.setItem(STORAGE_KEY, name);
    setAccentState(name);
  }

  return { accent, setAccent };
}
