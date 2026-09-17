import {
  CircleDotIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MonitorIcon,
  PlayIcon,
  ShareIcon,
  UsersIcon,
  VideoIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createPortal } from "react-dom";
import { Tooltip } from "@/components/motion/tooltip";
import { useExtensionCommands, useExtensionHost } from "@/lib/extensions/react-context";
import { cn } from "@/lib/utils";

const TOOLBAR = '[data-tour="header-actions"]';

function iconFor(name: string | undefined) {
  switch (name) {
    case "users":
      return UsersIcon;
    case "video":
      return VideoIcon;
    case "monitor":
      return MonitorIcon;
    case "chat":
      return MessageSquareIcon;
    case "share":
      return ShareIcon;
    case "database":
      return DatabaseIcon;
    case "play":
      return PlayIcon;
    default:
      return CircleDotIcon;
  }
}

function useToolbarNode() {
  const [node, setNode] = useState<Element | null>(null);
  useEffect(() => {
    const find = () => setNode(document.querySelector(TOOLBAR));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return node;
}

export function ExtensionToolbarItems() {
  const host = useExtensionHost();
  const commands = useExtensionCommands();
  const node = useToolbarNode();
  const entries = host.commands.menusFor("toolbar");
  if (!node || entries.length === 0) return null;

  return createPortal(
    <>
      {entries.map((entry) => {
        const command = commands.find((candidate) => candidate.id === entry.command);
        if (!command) return null;
        const Icon = iconFor(command.icon);
        return (
          <Tooltip key={entry.command} content={command.title} side="bottom">
            <button
              type="button"
              aria-label={command.title}
              onClick={() => {
                void host.executeCommand(entry.command).catch((error: unknown) => {
                  toast.error(command.title, {
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
              }}
              className={cn(
                "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full",
                "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={2} />
            </button>
          </Tooltip>
        );
      })}
    </>,
    node,
  );
}
