import { useEffect, useRef } from "react";
import { useExtensionPanels } from "@/lib/extensions/react-context";
import { useTableTabs } from "@/lib/table-tabs";
import { router } from "@/router";

export function ExtensionPanelOpener() {
  const panels = useExtensionPanels();
  const openExtensionPanel = useTableTabs((state) => state.openExtensionPanel);
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    for (const panel of panels) {
      if (panel.surface === "overlay") continue;
      const key = `${panel.extensionId}:${panel.panelId}`;
      if (panel.updatedAt <= (seen.current.get(key) ?? 0)) continue;
      seen.current.set(key, panel.updatedAt);
      openExtensionPanel({
        extensionId: panel.extensionId,
        panelId: panel.panelId,
        title: panel.title,
      });
      void router.navigate({
        to: "/extension-panels/$extensionId/$panelId",
        params: { extensionId: panel.extensionId, panelId: panel.panelId },
      });
    }
  }, [panels, openExtensionPanel]);

  return null;
}
