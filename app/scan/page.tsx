'use client';

import React, { useState, useRef } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';


import { Scan, X, Check, AlertCircle } from 'lucide-react';

export default function ScanPage() {
    const [status, setStatus] = useState<'ready' | 'scanning' | 'success' | 'error' | 'busy'>('ready');
    const [message, setMessage] = useState<string>('Ready to scan');
    const [lastResult, setLastResult] = useState<any>(null);
    const [history, setHistory] = useState<Array<{ code: string; time: string; ok: boolean; msg?: string }>>([]);
    const [scannerVisible, setScannerVisible] = useState(false);
    const processingRef = useRef<Set<string>>(new Set());
    const lastSeenRef = useRef<Map<string, number>>(new Map());

    const handleScan = async (detectedCodes: { rawValue: string }[]) => {
        if (detectedCodes.length === 0) return;

        let code = detectedCodes[0].rawValue;

        // normalize - extract code from URL if needed
        try {
            const url = new URL(code, window.location.href);
            const maybe = url.searchParams.get('code');
            if (maybe) code = maybe;
        } catch { }

        const now = Date.now();
        const last = lastSeenRef.current.get(code) ?? 0;
        if (now - last < 1300) return; // cooldown to prevent duplicate scans
        lastSeenRef.current.set(code, now);

        if (processingRef.current.has(code)) return;
        processingRef.current.add(code);

        setStatus('busy');
        setMessage('Checking in...');

        try {
            const res = await fetch('/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticketCode: code,
                    terminalId: '904f9bad-9949-41ee-9221-067aed7630ee'
                }),
            });
            const data = await res.json();
            setLastResult(data);

            const ok = res.ok && data.ok;

            // update history
            setHistory((h) => [
                { code, time: new Date().toISOString(), ok, msg: data?.message ?? data?.error ?? '' },
                ...h
            ].slice(0, 20));

            if (ok) {
                // success feedback
                try { navigator.vibrate?.(200); } catch { }
                setStatus('success');
                setMessage(`✓ Checked in: ${data.ticket?.ticket_code ?? code}`);
            } else {
                setStatus('error');
                setMessage(data?.message ?? JSON.stringify(data?.error) ?? 'Check-in failed');
            }
        } catch (err) {
            console.error('fetch error', err);
            setStatus('error');
            setMessage('Network error during check-in');
            setHistory((h) => [
                { code, time: new Date().toISOString(), ok: false, msg: 'network error' },
                ...h
            ].slice(0, 20));
        } finally {
            processingRef.current.delete(code);
            // revert status after showing message
            setTimeout(() => {
                setStatus(scannerVisible ? 'scanning' : 'ready');
                setMessage(scannerVisible ? 'Point camera at QR code' : 'Ready to scan');
            }, 1800);
        }
    };

    const handleError = (error: unknown) => {
        console.error('QR Scanner Error:', error);
    };

    const manualCheck = async (value: string) => {
        const code = value.trim();
        if (!code) return;

        setStatus('busy');
        setMessage('Checking in...');

        try {
            const res = await fetch('/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticketCode: code,
                    terminalId: '904f9bad-9949-41ee-9221-067aed7630ee'
                }),
            });
            const data = await res.json();
            setLastResult(data);

            const ok = res.ok && data.ok;
            setHistory((h) => [
                { code, time: new Date().toISOString(), ok, msg: data?.message ?? '' },
                ...h
            ].slice(0, 20));

            setStatus(ok ? 'success' : 'error');
            setMessage(data?.message ?? data?.error ?? (ok ? 'Done' : 'Failed'));
        } catch (e) {
            console.error(e);
            setStatus('error');
            setMessage('Network error');
        } finally {
            setTimeout(() => {
                setStatus(scannerVisible ? 'scanning' : 'ready');
                setMessage(scannerVisible ? 'Point camera at QR code' : 'Ready to scan');
            }, 1800);
        }
    };

    const toggleScanner = () => {
        const newVisible = !scannerVisible;
        setScannerVisible(newVisible);
        if (newVisible) {
            setStatus('scanning');
            setMessage('Point camera at QR code');
        } else {
            setStatus('ready');
            setMessage('Ready to scan');
        }
    };

    return (
        <div className="max-w-2xl mx-auto p-4">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Quick Scan Check-in</h2>
                <div className="text-sm text-slate-500">
                    Terminal: <span className="font-medium">Gate Phone</span>
                </div>
            </div>

            <div>
                <div>
                    <div className="flex items-center justify-between">
                        <span>QR Code Scanner</span>
                        <div className={`px-3 py-1 rounded-md text-sm font-medium ${status === 'success' ? 'bg-green-100 text-green-800' :
                            status === 'error' ? 'bg-red-100 text-red-800' :
                                status === 'scanning' ? 'bg-blue-100 text-blue-800' :
                                    'bg-slate-100 text-slate-700'
                            }`}>
                            {status === 'scanning' ? 'Scanning' :
                                status === 'busy' ? 'Working...' :
                                    status === 'success' ? 'Success' :
                                        status === 'error' ? 'Error' : 'Ready'}
                        </div>
                    </div>
                </div>
                <div className="space-y-4">
                    <button
                        onClick={toggleScanner}
                        className={`w-full ${scannerVisible ? "bg-red-900" : "bg-black"}`}

                    >
                        {scannerVisible ? (
                            <>
                                <X className="mr-2 h-4 w-4" /> Stop Scanner
                            </>
                        ) : (
                            <>
                                <Scan className="mr-2 h-4 w-4" /> Start Scanner
                            </>
                        )}
                    </button>

                    {scannerVisible && (
                        <div className="w-full aspect-square bg-black rounded-lg overflow-hidden">
                            <Scanner
                                onScan={handleScan}
                                onError={handleError}
                                constraints={{ facingMode: 'environment' }}
                            />
                        </div>
                    )}

                    <div className={`p-3 rounded-lg flex items-center gap-2 ${status === 'success' ? 'bg-green-50 text-green-800' :
                        status === 'error' ? 'bg-red-50 text-red-800' :
                            'bg-slate-50 text-slate-700'
                        }`}>
                        {status === 'success' && <Check className="h-5 w-5" />}
                        {status === 'error' && <AlertCircle className="h-5 w-5" />}
                        <span className="text-sm font-medium">{message}</span>
                    </div>

                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-slate-700">
                            Manual Code Entry
                        </label>
                        <div className="flex gap-2">
                            <input
                                id="manual"
                                className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                                placeholder="Paste or type ticket code"
                            />
                            <button
                                onClick={() => {
                                    const el = document.getElementById('manual') as HTMLInputElement | null;
                                    if (!el) return;
                                    manualCheck(el.value);
                                    el.value = '';
                                }}
                            >
                                Check In
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-slate-700">
                                Recent Scans
                            </label>
                            <button

                                onClick={() => {
                                    setHistory([]);
                                    setLastResult(null);
                                }}
                            >
                                Clear
                            </button>
                        </div>
                        <div className="space-y-2 max-h-64 overflow-auto">
                            {history.length === 0 ? (
                                <div className="text-sm text-slate-400 text-center py-4">
                                    No recent scans
                                </div>
                            ) : (
                                history.map((h, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between p-3 rounded-md border bg-white"
                                    >
                                        <div className="flex-1 min-w-0 mr-3">
                                            <div className="font-mono text-sm truncate">{h.code}</div>
                                            <div className="text-xs text-slate-500">
                                                {new Date(h.time).toLocaleString()}
                                            </div>
                                        </div>
                                        <div className={`text-xs font-semibold whitespace-nowrap ${h.ok ? 'text-green-600' : 'text-red-600'
                                            }`}>
                                            {h.ok ? '✓ OK' : (h.msg || 'Failed')}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {lastResult && (
                        <details className="text-xs">
                            <summary className="cursor-pointer text-slate-600 font-medium mb-2">
                                Last Result (Raw JSON)
                            </summary>
                            <pre className="bg-slate-50 p-3 rounded border overflow-auto max-h-40">
                                {JSON.stringify(lastResult, null, 2)}
                            </pre>
                        </details>
                    )}
                </div>
            </div>
        </div>
    );
}