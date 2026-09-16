import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Package,
  ArrowRight,
  PlusCircle,
  Users,
  Shield,
  Loader2,
  AlertCircle,
  CheckCircle,
  Upload,
  X,
  RefreshCw,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useFreighter } from '../hooks/useFreighter';
import * as api from '../services/api';
import { BatchCard } from '../components/BatchCard';
import { BatchQRCode } from '../components/BatchQRCode';
import { Badge } from '../components/Badge';
import { Layout } from '../components/layout/Layout';
import type { Batch, Actor, Role } from '../types';

const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';

// ─── Helper ──────────────────────────────────────────────────────────────────

function truncateAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-stellar-600 text-stellar-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      }`}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span
          className={`ml-1 px-1.5 py-0.5 rounded-full text-xs font-semibold ${
            active ? 'bg-stellar-100 text-stellar-700' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── My Batches Tab ──────────────────────────────────────────────────────────

function MyBatchesTab({
  onTransfer,
  onView,
}: {
  onTransfer: (batch: Batch) => void;
  onView: (batch: Batch) => void;
}) {
  const { data: batches, isLoading, isError, refetch } = useQuery({
    queryKey: ['my-batches'],
    queryFn: api.getMyBatches,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-stellar-600 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AlertCircle className="w-10 h-10 text-red-400" />
        <p className="text-gray-600">Failed to load batches.</p>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 text-sm text-stellar-600 hover:underline"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }

  if (!batches || batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <Package className="w-12 h-12 text-gray-300" />
        <p className="text-gray-600 font-medium">No batches in your custody</p>
        <p className="text-gray-400 text-sm">
          Register a new batch or wait for a transfer.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {batches.map((batch) => (
        <BatchCard
          key={batch.id}
          batch={batch}
          onTransfer={() => onTransfer(batch)}
          onView={() => onView(batch)}
        />
      ))}
    </div>
  );
}

// ─── Register Batch Tab ───────────────────────────────────────────────────────

function RegisterBatchTab() {
  const { actor } = useAuth();
  const { signTx } = useFreighter();
  const qclient = useQueryClient();

  const [form, setForm] = useState({
    productName: '',
    origin: '',
    description: '',
    harvestDate: '',
    notes: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<'idle' | 'preparing' | 'signing' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdBatch, setCreatedBatch] = useState<Batch | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleField(key: keyof typeof form, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!actor) return;
    setErrorMsg(null);

    try {
      setStatus('preparing');
      const fd = new FormData();
      fd.append('productName', form.productName);
      fd.append('origin', form.origin);
      fd.append('description', form.description);
      fd.append('harvestDate', form.harvestDate);
      fd.append('notes', form.notes);
      fd.append('producerAddr', actor.address);
      // Backend multer is configured with upload.array('files', 5) — field name must match.
      files.forEach((f) => fd.append('files', f));

      const prepared = await api.prepareBatch(fd);

      setStatus('signing');
      const signedXdr = await signTx(prepared.unsignedXdr, NETWORK_PASSPHRASE);

      setStatus('submitting');
      const batch = await api.submitBatch({
        signedXdr,
        metadataHash: prepared.metadataHash,
        metadata: {
          productName: form.productName,
          origin: form.origin,
          description: form.description,
          harvestDate: form.harvestDate,
          notes: form.notes,
        },
        ipfsCids: prepared.ipfsCids,
      });

      setCreatedBatch(batch);
      setStatus('done');
      qclient.invalidateQueries({ queryKey: ['my-batches'] });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to register batch');
      setStatus('error');
    }
  }

  function reset() {
    setForm({ productName: '', origin: '', description: '', harvestDate: '', notes: '' });
    setFiles([]);
    setStatus('idle');
    setErrorMsg(null);
    setCreatedBatch(null);
  }

  if (status === 'done' && createdBatch) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
          <CheckCircle className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
          <h3 className="text-xl font-bold text-emerald-900">Batch Registered!</h3>
          <p className="text-emerald-700 text-sm mt-1">
            Your batch has been registered on the Stellar blockchain.
          </p>
          <div className="mt-4 bg-white rounded-xl p-4 text-left border border-emerald-200">
            <p className="text-xs text-gray-500">Batch Chain ID</p>
            <p className="font-mono text-sm text-gray-900 break-all mt-1">
              {createdBatch.chainId}
            </p>
          </div>

          {/* QR code is generated in-browser from the batch's on-chain ID —
              it encodes the public /verify/{id} URL. */}
          <div className="mt-5">
            <BatchQRCode batchId={createdBatch.chainId} size={176} />
            <p className="text-xs text-emerald-700/70 mt-3">
              Print this on the packaging. Anyone can scan it to verify provenance.
            </p>
          </div>

          <button
            onClick={reset}
            className="mt-4 w-full px-4 py-2.5 border border-emerald-300 text-emerald-800 text-sm font-medium rounded-xl hover:bg-emerald-100 transition-colors"
          >
            Register Another Batch
          </button>
        </div>
      </div>
    );
  }

  const isBusy = ['preparing', 'signing', 'submitting'].includes(status);

  const statusLabel: Partial<Record<typeof status, string>> = {
    preparing: 'Preparing transaction…',
    signing: 'Waiting for Freighter signature…',
    submitting: 'Submitting to Stellar…',
  };

  return (
    <div className="max-w-lg mx-auto">
      <form onSubmit={handleSubmit} className="space-y-5">
        {errorMsg && (
          <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{errorMsg}</p>
          </div>
        )}

        {isBusy && (
          <div className="flex items-center gap-3 p-4 bg-stellar-50 border border-stellar-200 rounded-xl">
            <Loader2 className="w-5 h-5 text-stellar-600 animate-spin flex-shrink-0" />
            <p className="text-sm text-stellar-800 font-medium">{statusLabel[status]}</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Product Name <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={form.productName}
              onChange={(e) => handleField('productName', e.target.value)}
              placeholder="e.g. Arabica Coffee Beans"
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Origin / Region <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={form.origin}
              onChange={(e) => handleField('origin', e.target.value)}
              placeholder="e.g. Yirgacheffe, Ethiopia"
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            value={form.description}
            onChange={(e) => handleField('description', e.target.value)}
            placeholder="Product description, quality grade, certifications…"
            rows={3}
            className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent resize-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Harvest / Manufacture Date
            </label>
            <input
              type="date"
              value={form.harvestDate}
              onChange={(e) => handleField('harvestDate', e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Additional Notes
            </label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => handleField('notes', e.target.value)}
              placeholder="e.g. Organic certified"
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Document upload */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Supporting Documents
          </label>
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-stellar-400 hover:bg-stellar-50 transition-colors"
          >
            <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-600 font-medium">Click to upload</p>
            <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, WebP up to 10 MB · max 5 files</p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </div>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {files.map((f, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm"
                >
                  <span className="text-gray-700 truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="ml-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="submit"
          disabled={isBusy || !form.productName || !form.origin}
          className="w-full flex items-center justify-center gap-2 px-5 py-3.5 bg-stellar-600 hover:bg-stellar-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm"
        >
          {isBusy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <PlusCircle className="w-5 h-5" />
          )}
          {isBusy ? statusLabel[status] : 'Register Batch on Stellar'}
        </button>
      </form>
    </div>
  );
}

// ─── Transfer Tab ─────────────────────────────────────────────────────────────

function TransferTab({ preselectedBatch }: { preselectedBatch?: Batch }) {
  const { actor } = useAuth();
  const { signTx } = useFreighter();
  const qclient = useQueryClient();

  const { data: myBatches, isLoading: loadingBatches } = useQuery({
    queryKey: ['my-batches'],
    queryFn: api.getMyBatches,
  });

  const { data: actors, isLoading: loadingActors } = useQuery({
    queryKey: ['actors'],
    queryFn: () => api.getActors(),
  });

  const [selectedBatchId, setSelectedBatchId] = useState<string>(
    preselectedBatch?.id ?? ''
  );
  const [toAddress, setToAddress] = useState('');
  const [location, setLocation] = useState('');
  const [docFile, setDocFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'preparing' | 'signing' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const docFileRef = useRef<HTMLInputElement>(null);

  const eligibleActors = actors?.filter((a) => a.address !== actor?.address && a.active) ?? [];

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatchId || !toAddress || !location) return;
    setErrorMsg(null);

    try {
      setStatus('preparing');
      const fd = new FormData();
      fd.append('toAddress', toAddress);
      fd.append('location', location);
      if (docFile) fd.append('document', docFile);

      const prepared = await api.prepareTransfer(selectedBatchId, fd);

      setStatus('signing');
      const signedXdr = await signTx(prepared.unsignedXdr, NETWORK_PASSPHRASE);

      setStatus('submitting');
      await api.submitTransfer(selectedBatchId, {
        signedXdr,
        toAddress,
        location,
        docHash: prepared.docHash,
        docIpfsCid: prepared.docIpfsCid,
      });

      setStatus('done');
      qclient.invalidateQueries({ queryKey: ['my-batches'] });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Transfer failed');
      setStatus('error');
    }
  }

  function reset() {
    setSelectedBatchId('');
    setToAddress('');
    setLocation('');
    setDocFile(null);
    setStatus('idle');
    setErrorMsg(null);
  }

  if (status === 'done') {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
          <CheckCircle className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
          <h3 className="text-xl font-bold text-emerald-900">Transfer Complete!</h3>
          <p className="text-emerald-700 text-sm mt-1">
            Custody has been transferred and recorded on Stellar.
          </p>
          <button
            onClick={reset}
            className="mt-5 w-full px-4 py-2.5 border border-emerald-300 text-emerald-800 text-sm font-medium rounded-xl hover:bg-emerald-100 transition-colors"
          >
            Transfer Another
          </button>
        </div>
      </div>
    );
  }

  const isBusy = ['preparing', 'signing', 'submitting'].includes(status);

  const statusLabel: Partial<Record<typeof status, string>> = {
    preparing: 'Preparing transfer…',
    signing: 'Waiting for Freighter signature…',
    submitting: 'Submitting to Stellar…',
  };

  return (
    <div className="max-w-lg mx-auto">
      <form onSubmit={handleTransfer} className="space-y-5">
        {errorMsg && (
          <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{errorMsg}</p>
          </div>
        )}

        {isBusy && (
          <div className="flex items-center gap-3 p-4 bg-stellar-50 border border-stellar-200 rounded-xl">
            <Loader2 className="w-5 h-5 text-stellar-600 animate-spin flex-shrink-0" />
            <p className="text-sm text-stellar-800 font-medium">{statusLabel[status]}</p>
          </div>
        )}

        {/* Batch select */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Select Batch <span className="text-red-500">*</span>
          </label>
          {loadingBatches ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading batches…
            </div>
          ) : (
            <select
              required
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 bg-white"
            >
              <option value="">Choose a batch…</option>
              {myBatches?.map((b) => {
                const name =
                  typeof b.metadata?.productName === 'string'
                    ? b.metadata.productName
                    : typeof b.metadata?.name === 'string'
                    ? b.metadata.name
                    : 'Unnamed';
                return (
                  <option key={b.id} value={b.id}>
                    {name} — {truncateAddr(b.chainId)}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        {/* To actor */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Transfer To <span className="text-red-500">*</span>
          </label>
          {loadingActors ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading actors…
            </div>
          ) : (
            <select
              required
              value={toAddress}
              onChange={(e) => setToAddress(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 bg-white"
            >
              <option value="">Select recipient actor…</option>
              {eligibleActors.map((a) => (
                <option key={a.id} value={a.address}>
                  {a.name} ({a.role}) — {truncateAddr(a.address)}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Location */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Transfer Location <span className="text-red-500">*</span>
          </label>
          <input
            required
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Port of Rotterdam, Netherlands"
            className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 focus:border-transparent"
          />
        </div>

        {/* Document */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Transfer Document (optional)
          </label>
          <div
            onClick={() => docFileRef.current?.click()}
            className="border-2 border-dashed border-gray-300 rounded-xl p-5 text-center cursor-pointer hover:border-stellar-400 hover:bg-stellar-50 transition-colors"
          >
            <Upload className="w-6 h-6 text-gray-400 mx-auto mb-1.5" />
            <p className="text-sm text-gray-600">
              {docFile ? docFile.name : 'Upload bill of lading, certificate, etc.'}
            </p>
            <input
              ref={docFileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={isBusy || !selectedBatchId || !toAddress || !location}
          className="w-full flex items-center justify-center gap-2 px-5 py-3.5 bg-stellar-600 hover:bg-stellar-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm"
        >
          {isBusy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <ArrowRight className="w-5 h-5" />
          )}
          {isBusy ? statusLabel[status] : 'Transfer Custody'}
        </button>
      </form>
    </div>
  );
}

// ─── Admin Tab ────────────────────────────────────────────────────────────────

function AdminTab() {
  const { data: allActors, isLoading, refetch } = useQuery({
    queryKey: ['actors'],
    queryFn: () => api.getActors(),
  });

  const qclient = useQueryClient();

  const [form, setForm] = useState({
    address: '',
    role: 'Producer' as Role,
    name: '',
    contactInfo: '',
  });
  const [registerStatus, setRegisterStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [registerError, setRegisterError] = useState<string | null>(null);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setRegisterError(null);
    setRegisterStatus('loading');
    try {
      await api.registerActor(form);
      setRegisterStatus('done');
      setForm({ address: '', role: 'Producer', name: '', contactInfo: '' });
      qclient.invalidateQueries({ queryKey: ['actors'] });
      setTimeout(() => setRegisterStatus('idle'), 3000);
    } catch (e) {
      setRegisterError(e instanceof Error ? e.message : 'Failed to register actor');
      setRegisterStatus('error');
    }
  }

  // Admin is set at deploy time only — it cannot be assigned through this UI.
  // Exposing it here could mislead admins into attempting to create a second
  // admin actor, which the backend schema and contract do not support via this endpoint.
  const roles: Role[] = ['Producer', 'Processor', 'Distributor', 'Retailer', 'Auditor'];

  return (
    <div className="space-y-8">
      {/* Register actor form */}
      <div className="max-w-lg">
        <h3 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
          <PlusCircle className="w-5 h-5 text-stellar-600" />
          Register New Actor
        </h3>

        {registerStatus === 'done' && (
          <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl mb-4">
            <CheckCircle className="w-5 h-5 text-emerald-500" />
            <p className="text-sm text-emerald-800 font-medium">Actor registered successfully.</p>
          </div>
        )}

        {registerError && (
          <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl mb-4">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <p className="text-sm text-red-700">{registerError}</p>
          </div>
        )}

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Stellar Address <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              placeholder="G… (56 character Stellar public key)"
              maxLength={56}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">{form.address.length}/56 characters</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Role <span className="text-red-500">*</span>
              </label>
              <select
                required
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500 bg-white"
              >
                {roles.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                required
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Organization name"
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contact Info
            </label>
            <input
              type="text"
              value={form.contactInfo}
              onChange={(e) => setForm((f) => ({ ...f, contactInfo: e.target.value }))}
              placeholder="email@example.com or phone"
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stellar-500"
            />
          </div>

          <button
            type="submit"
            disabled={registerStatus === 'loading' || form.address.length !== 56 || !form.name}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-stellar-600 hover:bg-stellar-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm"
          >
            {registerStatus === 'loading' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PlusCircle className="w-4 h-4" />
            )}
            {registerStatus === 'loading' ? 'Registering…' : 'Register Actor'}
          </button>
        </form>
      </div>

      {/* Actor list */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-stellar-600" />
            All Actors
            {allActors && (
              <span className="text-sm font-normal text-gray-500">({allActors.length})</span>
            )}
          </h3>
          <button
            onClick={() => refetch()}
            className="text-sm text-stellar-600 hover:underline flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-stellar-600 animate-spin" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">Address</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Joined</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {allActors?.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{a.name}</td>
                    <td className="px-4 py-3">
                      <Badge role={a.role as Role} />
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-500 hidden sm:table-cell">
                      {truncateAddr(a.address)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          a.active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {a.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden md:table-cell">
                      {(() => {
                        try {
                          return format(parseISO(a.createdAt), 'MMM d, yyyy');
                        } catch {
                          return a.createdAt;
                        }
                      })()}
                    </td>
                  </tr>
                ))}
                {(!allActors || allActors.length === 0) && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                      No actors registered yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

type Tab = 'batches' | 'register' | 'transfer' | 'admin';

export function DashboardPage() {
  const { actor } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('batches');
  const [transferBatch, setTransferBatch] = useState<Batch | undefined>();

  function handleTransfer(batch: Batch) {
    setTransferBatch(batch);
    setActiveTab('transfer');
  }

  function handleView(batch: Batch) {
    navigate(`/verify/${batch.id}`);
  }

  if (!actor) return null;

  const isProducer = actor.role === 'Producer';
  const isAdmin = actor.role === 'Admin';

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {/* Page header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-gray-500 text-sm">{actor.name}</span>
              <Badge role={actor.role} size="sm" />
            </div>
          </div>
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-stellar-600 flex items-center justify-center text-white font-bold text-lg">
            {actor.name.charAt(0).toUpperCase()}
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-6 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 min-w-max">
            <TabButton
              active={activeTab === 'batches'}
              onClick={() => setActiveTab('batches')}
              icon={<Package className="w-4 h-4" />}
              label="My Batches"
            />
            {isProducer && (
              <TabButton
                active={activeTab === 'register'}
                onClick={() => setActiveTab('register')}
                icon={<PlusCircle className="w-4 h-4" />}
                label="Register Batch"
              />
            )}
            <TabButton
              active={activeTab === 'transfer'}
              onClick={() => setActiveTab('transfer')}
              icon={<ArrowRight className="w-4 h-4" />}
              label="Transfer Custody"
            />
            {isAdmin && (
              <TabButton
                active={activeTab === 'admin'}
                onClick={() => setActiveTab('admin')}
                icon={<Shield className="w-4 h-4" />}
                label="Admin"
              />
            )}
          </nav>
        </div>

        {/* Tab content */}
        <div>
          {activeTab === 'batches' && (
            <MyBatchesTab onTransfer={handleTransfer} onView={handleView} />
          )}
          {activeTab === 'register' && isProducer && <RegisterBatchTab />}
          {activeTab === 'transfer' && (
            <TransferTab preselectedBatch={transferBatch} />
          )}
          {activeTab === 'admin' && isAdmin && <AdminTab />}
        </div>
      </div>
    </Layout>
  );
}
