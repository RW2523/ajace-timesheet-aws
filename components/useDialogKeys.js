"use client";
import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// The keyboard contract every dialog in this app owes its user: Escape closes
// it, Tab stays inside it, and focus goes back where it came from when it shuts.
//
// This lived inline in DayModal and nowhere else, so four of the five dialogs —
// including both an ordinary employee ever meets (the period switch and the
// submitted! card) — could not be dismissed from the keyboard at all, and
// tabbing out of one walked into the page still sitting behind it. Copying the
// effect four times is how they drift apart, so it is one function.
//
// Returns the ref to put on the dialog element (the `.modal`, not the backdrop —
// the backdrop is not what Tab should be confined to).
// ---------------------------------------------------------------------------
export default function useDialogKeys(onClose) {
  const dialogRef = useRef(null);
  const restoreFocusTo = useRef(null);

  useEffect(() => {
    restoreFocusTo.current = document.activeElement;
    function onKeyDown(e) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const f = dialogRef.current?.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!f || !f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    // capture phase: a nested dialog (the day editor opened from inside the
    // admin panels) must get Escape first, and it stops propagation there.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // hand focus back to where the user was, not to the top of the document
      if (restoreFocusTo.current?.focus) restoreFocusTo.current.focus();
    };
  }, [onClose]);

  return dialogRef;
}
