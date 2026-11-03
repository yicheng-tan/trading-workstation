import React, { createContext, useContext } from 'react';
import type { DataHubClient } from '../core/hub/DataHubClient';

const DataHubReactContext = createContext<DataHubClient | null>(null);

export function DataHubProvider({
  client,
  children,
}: {
  client: DataHubClient;
  children: React.ReactNode;
}) {
  return <DataHubReactContext.Provider value={client}>{children}</DataHubReactContext.Provider>;
}

/** Every panel/workspace component reads the hub through this hook - never constructs its own SharedWorker connection. */
export function useDataHub(): DataHubClient {
  const client = useContext(DataHubReactContext);
  if (!client) {
    throw new Error('useDataHub() called outside a <DataHubProvider>');
  }
  return client;
}
