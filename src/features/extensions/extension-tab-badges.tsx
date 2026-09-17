import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { editorBridge } from "@/lib/extensions/editor-bridge";

export function ExtensionTabBadges() {
  const [badges, setBadges] = useState(() => editorBridge.documentBadges());
  const [, redraw] = useState(0);

  useEffect(() => {
    const subscription = editorBridge.onBadgesChanged(setBadges);
    return () => subscription.dispose();
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => redraw((value) => value + 1));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {[...badges].map(([id, badge]) => {
        const host =
          document.querySelector(`[data-tab-key="query:${CSS.escape(id)}"]`) ??
          document.querySelector(`[data-tab-key="${CSS.escape(id)}"]`);
        if (!host) return null;
        return createPortal(
          <span
            title={badge}
            className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          >
            {badge}
          </span>,
          host,
          id,
        );
      })}
    </>
  );
}
