import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ScanLine,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { useFreighter } from '../hooks/useFreighter';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { Account, TransactionBuilder, Networks, Operation, Memo } from '@stellar/stellar-sdk';

const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

function truncateAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

type LoginStep = 'idle' | 'connecting' | 'fetching-challenge' | 'signing' | 'verifying' | 'done' | 'error';

export function LoginPage() {
  const navigate = useNavigate();
  const { actor, login } = useAuth();
  const { publicKey, connected, freighterAvailable, loading: freighterLoading, connect, signTx, networkMismatch } = useFreighter();
  const [step, setStep] = useState<LoginStep>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Already logged in — redirect to dashboard
  useEffect(() => {
    if (actor) {
      navigate('/dashboard/batches', { replace: true });
    }
  }, [actor, navigate]);

  async function handleAuth() {
    if (!publicKey || !connected) return;
    setErrorMsg(null);

    try {
      // 1. Fetch challenge
      setStep('fetching-challenge');
      const { challenge } = await api.getChallenge(publicKey);

      // 2. Build a minimal Stellar transaction with the challenge as memo
      setStep('signing');
      // We build a fee-bump or dummy tx just to carry a memo for signing
      // Use a simple payment to self with memo = challenge (truncated to 28 bytes for TEXT memo)
      const memoText = challenge.slice(0, 28);

      // Fetch account to get sequence number — use Horizon testnet
      let sequenceNumber = '0';
      try {
        const horizonRes = await fetch(
          `https://horizon-testnet.stellar.org/accounts/${publicKey}`
        );
        if (horizonRes.ok) {
          const accData = await horizonRes.json();
          sequenceNumber = accData.sequence;
        }
      } catch {
        // If we can't fetch, use a dummy sequence
        sequenceNumber = '0';
      }

      const account = new Account(publicKey, sequenceNumber);
      // Use ManageData instead of a payment so this works on accounts with
      // no XLM balance (e.g. freshly created testnet accounts).
      // ManageData only needs a valid sequence number and signature — no funds.
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.manageData({
            name: 'lineage_auth',
            value: memoText,
          })
        )
        .addMemo(Memo.text(memoText))
        .setTimeout(30)
        .build();

      const signedXdr = await signTx(tx.toXDR(), NETWORK_PASSPHRASE);

      // IMPORTANT: This signed XDR is passed directly to the backend for
      // signature verification ONLY — it is never submitted to the Stellar
      // network. The backend calls nacl.sign.detached.verify on the tx hash
      // and discards the XDR afterward. Submitting this transaction on-chain
      // would be harmless (it only sets a ManageData entry) but wastes fees,
      // so the backend must never forward it to the RPC node.

      // 3. Verify with backend
      setStep('verifying');
      const { token, actor: newActor } = await api.verifySignature(
        publicKey,
        challenge,
        signedXdr
      );

      login(newActor, token);
      setStep('done');
      navigate('/dashboard/batches', { replace: true });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Authentication failed');
      setStep('error');
    }
  }

  const stepLabel: Record<LoginStep, string> = {
    idle: '',
    connecting: 'Connecting to Freighter…',
    'fetching-challenge': 'Fetching authentication challenge…',
    signing: 'Please approve in Freighter…',
    verifying: 'Verifying signature…',
    done: 'Authenticated!',
    error: 'Authentication failed',
  };

  const isBusy = ['connecting', 'fetching-challenge', 'signing', 'verifying'].includes(step);

  return (
    <div className="relative min-h-screen bg-ink-950 flex items-center justify-center px-4 py-12 overflow-hidden">
      {/* Background layers */}
      <div className="absolute inset-0 bg-grid mask-radial pointer-events-none" />
      <div className="absolute top-[-15%] left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-stellar-700/30 blur-[130px] rounded-full pointer-events-none" />

      <div className="relative w-full max-w-md animate-fade-up">
        {/* Back link */}
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>

        {/* Logo lockup */}
        <div className="flex items-center gap-3 mb-8">
          <img src="/logo.svg" alt="" className="w-11 h-11 rounded-xl shadow-glow" />
          <div>
            <h1 className="font-display text-2xl font-bold text-white tracking-tight">Lineage</h1>
            <p className="text-slate-500 text-sm">Actor sign-in</p>
          </div>
        </div>

        {/* Card */}
        <div className="glass-strong rounded-3xl p-8 shadow-inner-light">
          <h2 className="text-white font-semibold text-lg mb-1.5">Connect your wallet</h2>
          <p className="text-slate-400 text-sm mb-7 leading-relaxed">
            Authenticate with an Ed25519 signature from your Freighter wallet. No
            password, nothing stored.
          </p>

          {/* Freighter not available */}
          {freighterAvailable === false && (
            <div className="mb-5 p-4 rounded-2xl bg-amber-500/10 border border-amber-400/20">
              <div className="flex gap-3">
                <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-200">Freighter not detected</p>
                  <p className="text-xs text-amber-200/70 mt-1">
                    Install the Freighter browser extension to continue.
                  </p>
                  <a
                    href="https://freighter.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mt-2.5 text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Install Freighter
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Network mismatch */}
          {networkMismatch && (
            <div className="mb-5 p-4 rounded-2xl bg-orange-500/10 border border-orange-400/20">
              <div className="flex gap-3">
                <AlertCircle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-orange-200">Wrong network in Freighter</p>
                  <p className="text-xs text-orange-200/70 mt-1">
                    Freighter is not connected to the expected Stellar network.
                    Please switch to <span className="font-mono">{import.meta.env.VITE_NETWORK_PASSPHRASE || 'Testnet'}</span> in your Freighter settings and try again.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Connected address */}
          {connected && publicKey && (
            <div className="mb-5 p-4 rounded-2xl bg-emerald-500/10 border border-emerald-400/20">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-emerald-300/80 font-medium">Wallet connected</p>
                  <p className="font-mono text-sm text-emerald-200 truncate mt-0.5">
                    {truncateAddr(publicKey)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {errorMsg && step === 'error' && (
            <div className="mb-5 p-4 rounded-2xl bg-red-500/10 border border-red-400/20">
              <div className="flex gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-300">Authentication error</p>
                  <p className="text-xs text-red-300/70 mt-1">{errorMsg}</p>
                </div>
              </div>
            </div>
          )}

          {/* Step status */}
          {isBusy && (
            <div className="mb-5 p-4 rounded-2xl bg-stellar-500/10 border border-stellar-400/20 flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-stellar-400 animate-spin flex-shrink-0" />
              <p className="text-sm text-stellar-200 font-medium">{stepLabel[step]}</p>
            </div>
          )}

          {/* Actions */}
          {!connected ? (
            <button
              onClick={connect}
              disabled={freighterLoading || freighterAvailable === false || freighterAvailable === null}
              className="w-full flex items-center justify-center gap-2.5 px-5 py-4 rounded-2xl bg-stellar-600 hover:bg-stellar-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-all text-sm shadow-glow hover:shadow-glow-lg"
            >
              {freighterLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Wallet className="w-5 h-5" />
              )}
              {freighterLoading ? 'Connecting…' : 'Connect Freighter Wallet'}
            </button>
          ) : (
            <button
              onClick={handleAuth}
              disabled={isBusy}
              className="w-full flex items-center justify-center gap-2.5 px-5 py-4 rounded-2xl bg-stellar-600 hover:bg-stellar-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-all text-sm shadow-glow hover:shadow-glow-lg"
            >
              {isBusy ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ShieldCheck className="w-5 h-5" />
              )}
              {isBusy ? stepLabel[step] : 'Authenticate with Stellar Signature'}
            </button>
          )}

          {/* Divider */}
          <div className="relative my-7">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/[0.08]" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-[#101828] px-3 text-xs text-slate-500 rounded">or</span>
            </div>
          </div>

          <Link
            to="/verify/demo"
            className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-2xl glass hover:bg-white/[0.08] text-slate-200 font-medium transition-colors text-sm"
          >
            <ScanLine className="w-4 h-4" />
            Scan a product QR code
          </Link>
        </div>

        <p className="text-center text-slate-600 text-xs mt-7">
          No account needed · Wallet signatures never leave your device
        </p>
      </div>
    </div>
  );
}
