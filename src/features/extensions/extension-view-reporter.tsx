import { useEffect } from "react";
import {
  reportWorkspaceView,
  setWorkspaceViewCloser,
  setWorkspaceViewOpener,
} from "@/lib/extensions/workspace-views";
import { navigateToTab } from "@/lib/tab-navigation";
import { type Tab, tabKey, useTableTabs } from "@/lib/table-tabs";
import { tabMatchesRoute } from "@/lib/use-active-workspace-tab";
import { router } from "@/router";

function reopen(state: ReturnType<typeof useTableTabs.getState>, tab: Tab): boolean {
  switch (tab.kind) {
    case "table":
      state.openTab({ schema: tab.schema, table: tab.table, entityType: tab.entityType });
      return true;
    case "tool":
      state.openToolTab(tab.tool);
      return true;
    case "function":
      state.openFunctionTab({ schema: tab.schema, name: tab.name, oid: tab.oid });
      return true;
    case "procedure":
      state.openProcedureTab({ schema: tab.schema, name: tab.name, oid: tab.oid });
      return true;
    case "role":
      state.openRoleTab({ name: tab.name });
      return true;
    case "trigger":
      state.openTriggerTab({ schema: tab.schema, table: tab.table, trigger: tab.trigger });
      return true;
    case "view-editor":
      state.openViewEditorTab({ schema: tab.schema, view: tab.view });
      return true;
    case "alter-table":
      state.openAlterTableTab({ schema: tab.schema, table: tab.table });
      return true;
    case "package":
      state.openPackageTab({ schema: tab.schema, name: tab.name });
      return true;
    default:
      return false;
  }
}

export function ExtensionViewReporter() {
  useEffect(() => {
    const match = (tab: Parameters<typeof tabKey>[0]) =>
      tabMatchesRoute((options) => router.matchRoute(options as never), tab);

    const publish = () => {
      reportWorkspaceView(useTableTabs.getState().tabs.find(match));
    };

    setWorkspaceViewOpener((tab) => {
      const state = useTableTabs.getState();
      const key = tabKey(tab);
      const open = state.tabs.some((candidate) => tabKey(candidate) === key);
      if (!open && !reopen(state, tab)) return false;
      navigateToTab((options) => router.navigate(options as never), tab);
      return true;
    });

    setWorkspaceViewCloser((key) => {
      const state = useTableTabs.getState();
      const index = state.tabs.findIndex((candidate) => tabKey(candidate) === key);
      if (index === -1) return false;
      const close = () => useTableTabs.getState().closeTab(key);
      if (!match(state.tabs[index])) {
        close();
        return true;
      }
      const next = state.tabs[index + 1] ?? state.tabs[index - 1];
      const left = next
        ? Promise.resolve(navigateToTab((options) => router.navigate(options as never), next))
        : router.navigate({ to: "/" } as never);
      void Promise.resolve(left).finally(close);
      return true;
    });

    publish();
    const unsubscribeTabs = useTableTabs.subscribe(publish);
    const unsubscribeRouter = router.subscribe("onResolved", publish);
    return () => {
      unsubscribeTabs();
      unsubscribeRouter();
      setWorkspaceViewOpener(null);
      setWorkspaceViewCloser(null);
    };
  }, []);
  return null;
}
