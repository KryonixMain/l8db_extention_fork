import { type Tab, tabKey, useTableTabs } from "@/lib/table-tabs";
import { editorBridge } from "./editor-bridge";

function queryTabs(tabs: Tab[]) {
  return tabs.filter((tab): tab is Extract<Tab, { kind: "query" }> => tab.kind === "query");
}

export function connectEditorTabs() {
  const attached = editorBridge.attach({
    listDocuments: () =>
      queryTabs(useTableTabs.getState().tabs).map((tab) => ({
        documentId: tab.id,
        title: tab.title,
        languageId: "sql",
        version: 0,
      })),
    readDocument: (documentId) => {
      const tab = queryTabs(useTableTabs.getState().tabs).find((entry) => entry.id === documentId);
      return tab ? { title: tab.title, languageId: "sql", text: tab.sql } : null;
    },
    replaceText: (documentId, text) => {
      useTableTabs.getState().updateQuerySql(documentId, text);
    },
    createDocument: (title, text) => {
      const documentId = useTableTabs.getState().openQueryTabWithSql(text, title);
      return { documentId, title, languageId: "sql", version: 1 };
    },
    closeDocument: (documentId) => {
      const tab = queryTabs(useTableTabs.getState().tabs).find((entry) => entry.id === documentId);
      if (!tab) return false;
      useTableTabs.getState().closeTab(tabKey(tab));
      return true;
    },
    activateDocument: (documentId) => {
      const tab = queryTabs(useTableTabs.getState().tabs).find((entry) => entry.id === documentId);
      if (!tab) return false;
      void Promise.all([import("@/router"), import("@/lib/tab-navigation")]).then(
        ([{ router }, { navigateToTab }]) =>
          navigateToTab((options) => router.navigate(options as never), tab),
      );
      return true;
    },
  });
  let previous = new Map(queryTabs(useTableTabs.getState().tabs).map((tab) => [tab.id, tab.sql]));
  const unsubscribe = useTableTabs.subscribe((state) => {
    const next = new Map(queryTabs(state.tabs).map((tab) => [tab.id, tab.sql]));
    for (const [documentId, sql] of next) {
      if (previous.get(documentId) !== sql) editorBridge.reportContent(documentId, sql);
    }
    for (const documentId of previous.keys()) {
      if (!next.has(documentId)) editorBridge.reportClosed(documentId);
    }
    previous = next;
  });
  return () => {
    unsubscribe();
    attached.dispose();
  };
}
