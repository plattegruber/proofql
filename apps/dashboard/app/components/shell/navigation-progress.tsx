// Pending UI: a hairline-thin accent bar across the top of the viewport for
// any navigation or submission that runs longer than 150ms — under that,
// showing anything would just flicker. No spinners, per the design system.
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

const SHOW_AFTER_MS = 150;

export function NavigationProgress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (busy) {
      timer.current = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    } else {
      clearTimeout(timer.current);
      setVisible(false);
    }
    return () => clearTimeout(timer.current);
  }, [busy]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      <div
        className="h-full bg-accent-600 transition-all duration-200 ease-out"
        style={{
          width: visible ? "80%" : busy ? "0%" : "100%",
          opacity: busy ? 1 : 0,
          transitionDuration: visible ? "10s" : "200ms",
        }}
      />
    </div>
  );
}
