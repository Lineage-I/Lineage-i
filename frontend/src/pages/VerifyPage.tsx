import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Package,
  User,
  Calendar,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import * as api from '../services/api';
import { Timeline } from '../components/Timeline';
import { Badge } from '../components/Badge';
import type { Role } from '../types';

const STELLAR_EXPLORER =
  import.meta.env.VITE_STELLAR_EXPLORER ||
  'https://stellar.expert/explorer/testnet';

const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || '';

function formatDate(iso: string): string {
  try {
    return format(parseISO(iso), 'MMMM d, yyyy');
  } catch {
    return iso;
  }
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4 py-3 border-b border-gray-100 last:border-0">
      <dt className="text-sm text-gray-500 capitalize flex-shrink-0 w-36">
        {label.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}
      </dt>
      <dd className="text-sm font-medium text-gray-900 text-right break-words min-w-0">
        {value}
      </dd>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-ink-950 pb-12 overflow-hidden">
      <div className="absolute inset-0 bg-grid mask-radial pointer-events-none" />
      <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-stellar-700/25 blur-[120px] rounded-full pointer-events-none" />
      <div className="relative">{children}</div>
    </div>
  );
}

export function VerifyPage() {
  const { batchId } = useParams<{ batchId: string }>();

  const {
    data: batch,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => api.getBatch(batchId!),
    enabled: !!batchId,
    // Retry up to 3 times with exponential backoff before showing the error
    // state. A single transient RPC hiccup should not surface "Batch Not Found"
    // to consumers scanning a QR code.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });

  if (!batchId) {
    return (
      <PageShell>
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="text-center animate-fade-up">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-white">Invalid QR Code</h1>
            <p className="text-slate-400 mt-2">No batch ID found in this URL.</p>
          </div>
        </div>
      </PageShell>
    );
  }

  if (isLoading) {
    return (
      <PageShell>
        <div className="min-h-screen flex flex-col items-center justify-center px-4">
          <div className="text-center animate-fade-up">
            <div className="relative inline-flex mb-6">
              <div className="absolute inset-0 bg-stellar-500/30 blur-2xl rounded-full" />
              <Loader2 className="relative w-12 h-12 text-stellar-400 animate-spin" />
            </div>
            <h2 className="font-display text-xl font-semibold text-white">
              Verifying provenance…
            </h2>
            <p className="text-slate-400 text-sm mt-2">
              Fetching data from the Stellar blockchain
            </p>
          </div>
        </div>
      </PageShell>
    );
  }

  if (isError || !batch) {
    return (
      <PageShell>
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-sm w-full animate-fade-up">
            <div className="glass-strong rounded-3xl p-8 text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-500/15 border border-red-400/25 mb-5">
                <AlertCircle className="w-7 h-7 text-red-400" />
              </div>
              <h2 className="font-display text-xl font-bold text-white">Batch Not Found</h2>
              <p className="text-slate-400 text-sm mt-3 leading-relaxed">
                This QR code may be invalid, expired, or the batch has not been
                registered yet.
              </p>
              {error instanceof Error && (
                <p className="text-red-300/80 text-xs mt-4 font-mono bg-red-500/10 border border-red-400/15 rounded-xl p-3 break-words">
                  {error.message}
                </p>
              )}
              <button
                onClick={() => refetch()}
                className="inline-flex items-center justify-center gap-2 mt-4 px-5 py-3 rounded-2xl bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors w-full"
              >
                <RefreshCw className="w-4 h-4" />
                Try again
              </button>
              <Link
                to="/"
                className="inline-flex items-center justify-center gap-2 mt-3 px-5 py-3 rounded-2xl bg-stellar-600 hover:bg-stellar-500 text-white text-sm font-semibold transition-colors w-full"
              >
                Return to home
              </Link>
            </div>
          </div>
        </div>
      </PageShell>
    );
  }

  const productName =
    typeof batch.metadata?.productName === 'string'
      ? batch.metadata.productName
      : typeof batch.metadata?.name === 'string'
      ? batch.metadata.name
      : 'Product';

  const metadataEntries = batch.metadata
    ? Object.entries(batch.metadata).filter(
        ([k]) => !['productName', 'name'].includes(k)
      )
    : [];

  return (
    <PageShell>
      {/* Verified banner */}
      <div className="px-4 pt-8 pb-2 text-center animate-fade-up">
        <a
          href={`${STELLAR_EXPLORER}/contract/${CONTRACT_ID}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 bg-emerald-500/15 border border-emerald-400/30 hover:bg-emerald-500/25 transition-colors text-emerald-300 font-semibold px-5 py-2.5 rounded-full text-sm"
        >
          <CheckCircle2 className="w-5 h-5" />
          Verified on Stellar
          <ExternalLink className="w-3.5 h-3.5 opacity-70" />
        </a>
        <p className="text-slate-500 text-xs mt-3">
          Immutable record — contract verified on Stellar testnet
        </p>
      </div>

      <div className="max-w-lg mx-auto px-4 pt-5 space-y-5">
        {/* Product hero card */}
        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden animate-fade-up-delay-1">
          <div className="h-1.5 bg-gradient-to-r from-stellar-600 to-emerald-500" />
          <div className="p-6">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-14 h-14 rounded-2xl bg-stellar-50 flex items-center justify-center">
                <Package className="w-7 h-7 text-stellar-600" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-xl font-bold text-gray-900 leading-tight">
                  {productName}
                </h1>
                <p className="text-xs text-gray-500 font-mono mt-1.5 break-all">
                  Batch: {batch.chainId}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3">
              {/* Producer */}
              <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl">
                <User className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500">Producer</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {batch.producer?.name ?? 'Unknown'}
                    </p>
                    {batch.producer?.role && (
                      <Badge role={batch.producer.role as Role} />
                    )}
                  </div>
                </div>
              </div>

              {/* Registered date */}
              <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl">
                <Calendar className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500">Registered</p>
                  <p className="text-sm font-semibold text-gray-900 mt-0.5">
                    {formatDate(batch.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Metadata section */}
        {metadataEntries.length > 0 && (
          <div className="bg-white rounded-3xl shadow-xl overflow-hidden animate-fade-up-delay-2">
            <div className="px-6 pt-6 pb-1">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-stellar-600" />
                Product Details
              </h2>
            </div>
            <dl className="px-6 pb-5">
              {metadataEntries.map(([key, val]) => (
                <MetadataItem
                  key={key}
                  label={key}
                  value={typeof val === 'string' ? val : JSON.stringify(val)}
                />
              ))}
            </dl>
          </div>
        )}

        {/* Chain of Custody */}
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden animate-fade-up-delay-3">
          <div className="px-6 pt-6 pb-5">
            <h2 className="text-base font-bold text-gray-900 mb-5 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Chain of Custody
              <span className="ml-auto text-xs font-normal text-gray-500">
                {batch.events.length + 1} step{batch.events.length !== 0 ? 's' : ''}
              </span>
            </h2>
            <Timeline
              events={batch.events}
              originActor={batch.producer}
              createdAt={batch.createdAt}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pb-4 pt-2">
          <Link to="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-300 text-xs transition-colors">
            <img src="/logo.svg" alt="" className="w-4 h-4 rounded" />
            Powered by <span className="font-semibold text-stellar-400">Lineage</span> · Stellar Blockchain
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
