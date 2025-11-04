'use client';

import React, { useEffect, useRef, useState } from 'react';

export default function ScanPage() {
    const [status, setStatus] = useState<'ready' | 'scanning' | 'success' | 'error' | 'busy'>('ready');
    const [message, setMessage] = useState<string>('Ready to scan');
    const [lastResult, setLastResult] = useState<any>(null);
    const [cameras, setCameras] = useState<Array<{ id: string; label?: string }>>([]);
    const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
    const [history, setHistory] = useState<Array<{ code: string; time: string; ok: boolean; msg?: string }>>([]);
    const [isRunning, setIsRunning] = useState(false);
    const processingRef = useRef<Set<string>>(new Set());
    const lastSeenRef = useRef<Map<string, number>>(new Map());
    const scannerRef = useRef<any>(null);
    const toneRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        // prepare short beep for success
        toneRef.current = typeof Audio !== 'undefined' ? new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAIARKwAABCxAgAEABAAZGF0YQAAAAA=') : null;
    }, []);

    useEffect(() => {
        let script: HTMLScriptElement | null = document.createElement('script');
        script.src = 'https://unpkg.com/html5-qrcode';
        script.async = true;

        script.onload = async () => {
            try {
                const Html5Qrcode = (window as any).Html5Qrcode;
                if (!Html5Qrcode) return setMessage('Scanner library unavailable');

                // detect cameras
                try {
                    const cams = await Html5Qrcode.getCameras();
                    const mapped = (cams || []).map((c: any) => ({ id: c.id, label: c.label || c.id }));
                    setCameras(mapped);
                    if (mapped.length) setSelectedCamera(mapped[0].id);
                } catch (e) {
                    // ignore camera-list errors (may happen on some browsers without permissions)
                }

                // create scanner instance but don't start until user clicks
                const scanner = new Html5Qrcode('reader', { formatsToSupport: ['QR_CODE'] });
                scannerRef.current = scanner;
            } catch (e) {
                console.error('scanner init', e);
                setMessage('Scanner init failed');
            }
        };

        script.onerror = () => setMessage('Failed to load scanner library');
        document.body.appendChild(script);

        return () => {
            (async () => {
                try {
                    if (scannerRef.current) {
                        await scannerRef.current.stop();
                        scannerRef.current.clear();
                    }
                } catch (e) {
                    // ignore
                }
                if (script) {
                    script.remove();
                    script = null;
                }
            })();
        };
    }, []);

    const startScanner = async () => {
        if (!scannerRef.current) return setMessage('Scanner not ready');
        setStatus('busy');
        setMessage('Starting camera...');

        try {
            const cameraId = selectedCamera ?? null;
            await scannerRef.current.start(
                cameraId,
                { fps: 10, qrbox: (window.innerWidth < 420 ? Math.floor(window.innerWidth * 0.7) : 420) },
                onDecode,
                () => {
                    // per-frame errors are ignored; could update flicker UI here
                }
            );
            setIsRunning(true);
            setStatus('scanning');
            setMessage('Scanning — point camera at QR code');
        } catch (e) {
            console.error('start scanner failed', e);
            setStatus('error');
            setMessage('Unable to access camera — check permissions or try a different camera.');
        }
    };

    const stopScanner = async () => {
        try {
            if (scannerRef.current) {
                await scannerRef.current.stop();
                scannerRef.current.clear();
            }
        } catch (e) {
            // ignore stop errors
        }
        setIsRunning(false);
        setStatus('ready');
        setMessage('Scanner stopped');
    };

    const onDecode = async (decodedText: string) => {
        // normalize
        let code = decodedText;
        try {
            const url = new URL(decodedText, window.location.href);
            const maybe = url.searchParams.get('code');
            if (maybe) code = maybe;
        } catch { }

        const now = Date.now();
        const last = lastSeenRef.current.get(code) ?? 0;
        if (now - last < 1300) return; // short cooldown
        lastSeenRef.current.set(code, now);

        if (processingRef.current.has(code)) return;
        processingRef.current.add(code);
        setStatus('busy');
        setMessage('Checking in...');

        try {
            const res = await fetch('/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketCode: code, terminalId: '904f9bad-9949-41ee-9221-067aed7630ee' }),
            });
            const data = await res.json();
            setLastResult(data);

            const ok = res.ok && data.ok;

            // update UI and history
            setHistory((h) => [{ code, time: new Date().toISOString(), ok, msg: data?.message ?? data?.error ?? '' }, ...h].slice(0, 20));

            if (ok) {
                // success beep & vibrate
                try { toneRef.current?.play(); } catch { }
                try { navigator.vibrate?.(200); } catch { }

                setStatus('success');
                setMessage(`Checked in: ${data.ticket?.ticket_code ?? code}`);
            } else {
                setStatus('error');
                setMessage(data?.message ?? JSON.stringify(data?.error) ?? 'Check-in failed');
            }
        } catch (err) {
            console.error('fetch error', err);
            setStatus('error');
            setMessage('Network error during check-in');
            setHistory((h) => [{ code, time: new Date().toISOString(), ok: false, msg: 'network' }, ...h].slice(0, 20));
        } finally {
            processingRef.current.delete(code);
            // revert to scanning after a short delay so user sees message
            setTimeout(() => {
                if (isRunning) {
                    setStatus('scanning');
                    setMessage('Scanning — point camera at QR code');
                } else {
                    setStatus('ready');
                    setMessage('Ready to scan');
                }
            }, 1400);
        }
    };

    const manualCheck = async (value: string) => {
        // quick manual fallback when camera not available
        const code = value.trim();
        if (!code) return;
        setStatus('busy');
        setMessage('Checking in...');
        try {
            const res = await fetch('/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketCode: code, terminalId: '904f9bad-9949-41ee-9221-067aed7630ee' }),
            });
            const data = await res.json();
            setLastResult(data);
            setHistory((h) => [{ code, time: new Date().toISOString(), ok: res.ok && data.ok, msg: data?.message ?? '' }, ...h].slice(0, 20));
            setStatus(res.ok && data.ok ? 'success' : 'error');
            setMessage(data?.message ?? data?.error ?? (res.ok ? 'Done' : 'Failed'));
        } catch (e) {
            console.error(e);
            setStatus('error');
            setMessage('Network error');
        } finally {
            setTimeout(() => {
                setStatus(isRunning ? 'scanning' : 'ready');
                setMessage(isRunning ? 'Scanning — point camera at QR code' : 'Ready to scan');
            }, 1400);
        }
    };

    return (
        <div className="max-w-2xl mx-auto p-4">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Quick Scan — Check-in</h2>
                <div className="text-sm text-slate-500">Terminal: <span className="font-medium">Gate Phone</span></div>
            </div>

            <div className="bg-white shadow rounded-lg overflow-hidden">
                <div id="reader" className="w-full h-[360px] bg-black/5 flex items-center justify-center" />

                <div className="p-3 border-t">
                    <div className="flex gap-2 items-center">
                        <select
                            className="flex-1 rounded px-2 py-1 border"
                            value={selectedCamera ?? ''}
                            onChange={(e) => setSelectedCamera(e.target.value)}
                        >
                            <option value="">Default camera</option>
                            {cameras.map((c) => (
                                <option key={c.id} value={c.id}>{c.label ?? c.id}</option>
                            ))}
                        </select>

                        {!isRunning ? (
                            <button className="px-3 py-1 rounded bg-blue-600 text-white" onClick={startScanner}>Start</button>
                        ) : (
                            <button className="px-3 py-1 rounded bg-red-600 text-white" onClick={stopScanner}>Stop</button>
                        )}

                        <button
                            className="px-3 py-1 rounded border"
                            onClick={() => {
                                // clear history
                                setHistory([]);
                                setLastResult(null);
                                setMessage('Ready to scan');
                                setStatus('ready');
                            }}
                        >Clear</button>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                        <div className={`px-3 py-1 rounded-md font-medium ${status === 'success' ? 'bg-green-100 text-green-800' : status === 'error' ? 'bg-red-100 text-red-800' : 'bg-slate-50 text-slate-700'}`}>
                            {status === 'scanning' ? 'Scanning' : status === 'busy' ? 'Working' : status === 'success' ? 'Success' : status === 'error' ? 'Error' : 'Ready'}
                        </div>
                        <div className="text-sm text-slate-600">{message}</div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-slate-500">Manual code</label>
                            <div className="flex gap-2 mt-1">
                                <input id="manual" className="flex-1 rounded border px-2 py-1" placeholder="Paste or type ticket code" />
                                <button className="px-3 py-1 rounded bg-slate-800 text-white" onClick={() => {
                                    const el = document.getElementById('manual') as HTMLInputElement | null;
                                    if (!el) return;
                                    manualCheck(el.value);
                                    el.value = '';
                                }}>Check</button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs text-slate-500">Last result (raw)</label>
                            <pre className="mt-1 max-h-28 overflow-auto text-xs bg-slate-50 p-2 rounded">{lastResult ? JSON.stringify(lastResult, null, 2) : '—'}</pre>
                        </div>
                    </div>

                    <div className="mt-3">
                        <div className="text-sm text-slate-500 mb-2">Recent scans</div>
                        <div className="space-y-2 max-h-40 overflow-auto">
                            {history.length === 0 ? (
                                <div className="text-xs text-slate-400">No recent scans</div>
                            ) : (
                                history.map((h, i) => (
                                    <div key={i} className="flex items-center justify-between text-sm p-2 rounded border">
                                        <div>
                                            <div className="font-mono text-xs">{h.code}</div>
                                            <div className="text-xs text-slate-500">{new Date(h.time).toLocaleString()}</div>
                                        </div>
                                        <div className={`text-xs font-medium ${h.ok ? 'text-green-600' : 'text-red-600'}`}>{h.ok ? 'OK' : (h.msg || 'Failed')}</div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>

        </div>
    );
}
