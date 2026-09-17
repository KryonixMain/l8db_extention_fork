import { ExtensionPanelView } from "@/features/extensions/extension-panel-view";
import { useExtensionPanels } from "@/lib/extensions/react-context";

export function ExtensionPanelOverlay() {
  const overlays = useExtensionPanels().filter((panel) => panel.surface === "overlay");
  if (overlays.length === 0) return null;
  return (
    <>
      {overlays.map((panel) => (
        <div
          key={`${panel.extensionId}:${panel.panelId}`}
          className="fixed z-40 [&>iframe]:size-full [&>iframe]:bg-transparent"
          style={{
            pointerEvents: panel.interactive ? "auto" : "none",
            ...(panel.bounds
              ? {
                  left: panel.bounds.x,
                  top: panel.bounds.y,
                  width: panel.bounds.width,
                  height: panel.bounds.height,
                }
              : { inset: 0 }),
          }}
          aria-hidden={!panel.interactive}
        >
          <ExtensionPanelView
            extensionId={panel.extensionId}
            panelId={panel.panelId}
            transparent
          />
        </div>
      ))}
    </>
  );
}
