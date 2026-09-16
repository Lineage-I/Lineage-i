import { useState, useEffect, useCallback } from 'react';

const EXPECTED_NETWORK =
  import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';

export function useFreighter() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freighterAvailable, setFreighterAvailable] = useState<boolean | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);

  useEffect(() => {
    import('@stellar/freighter-api')
      .then(({ isConnected, getAddress, getNetworkDetails }) => {
        setFreighterAvailable(true);
        isConnected().then(({ isConnected: ok }) => {
          if (ok) {
            getAddress().then(({ address, error: err }) => {
              if (address && !err) {
                setPublicKey(address);
                setConnected(true);
              }
            });
            // Check network on initial load
            getNetworkDetails().then(({ networkPassphrase }) => {
              setNetworkMismatch(networkPassphrase !== EXPECTED_NETWORK);
            }).catch(() => {});
          }
        });
      })
      .catch(() => {
        setFreighterAvailable(false);
      });
  }, []);

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { requestAccess, getNetworkDetails } = await import('@stellar/freighter-api');

      // Validate network before requesting access
      const { networkPassphrase } = await getNetworkDetails();
      if (networkPassphrase !== EXPECTED_NETWORK) {
        setNetworkMismatch(true);
        throw new Error(
          `Freighter is connected to the wrong network. ` +
          `Expected "${EXPECTED_NETWORK}" but got "${networkPassphrase}". ` +
          `Please switch Freighter to the correct network and try again.`
        );
      }
      setNetworkMismatch(false);

      const { address, error: err } = await requestAccess();
      if (err) throw new Error(err.message);
      if (!address) throw new Error('No public key returned');
      setPublicKey(address);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  const signTx = useCallback(
    async (txXdr: string, networkPassphrase: string): Promise<string> => {
      const { signTransaction } = await import('@stellar/freighter-api');
      const { signedTxXdr, error: err } = await signTransaction(txXdr, {
        networkPassphrase,
      });
      if (err) throw new Error(err.message);
      if (!signedTxXdr) throw new Error('No signed transaction returned');
      return signedTxXdr;
    },
    []
  );

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setConnected(false);
    localStorage.removeItem('token');
    localStorage.removeItem('actor');
  }, []);

  return {
    publicKey,
    connected,
    loading,
    error,
    freighterAvailable,
    networkMismatch,
    connect,
    signTx,
    disconnect,
  };
}
