/**
 * GoCardless plugin entry component.
 *
 * Mounts the full ported `GoCardlessImport` page (~2,500 lines lifted
 * from the legacy `frontend/src/pages/GoCardlessImport.tsx`) inside
 * SAM's plugin shell. See bank-reconcile/BankReconcile.tsx for the
 * design rationale of the wrapper pattern.
 */
import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SamPluginContext } from './sam';
import { setSamContext } from './api-shim';
import { GoCardlessImport } from './GoCardlessImport';

export default function GoCardless({
  context,
}: {
  context: SamPluginContext;
}) {
  useEffect(() => {
    setSamContext(context);
  }, [context]);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
    [],
  );

  return (
    <div className="gocardless-app">
      <QueryClientProvider client={queryClient}>
        <GoCardlessImport />
      </QueryClientProvider>
    </div>
  );
}
