import { type Tab, useTableTabs } from "@/lib/table-tabs";
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
  });
  let previous = new Map(queryTabs(useTableTabs.getState().tabs).map((tab) => [tab.id, tab.sql]));
  const unsubscribe = useTableTabs.subscribe((state) => {
    const next = new Map(queryTabs(state.tabs).map((tab) => [tab.id, tab.sql]));
    for (const [documentId, sql] of next) {
      if (previous.get(documentId) !== sql) editorBridge.reportContent(documentId, sql);
    }
    previous = next;
  });
  return () => {
    unsubscribe();
    attached.dispose();
  };
}
