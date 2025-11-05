'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Scanner } from '@yudiel/react-qr-scanner';
import { Scan, X, Check, AlertCircle, Users, Copy, CheckCircle } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

interface Attendee {
    id: string;
    name: string;
    email: string;
    phone?: string;
    ticket_code: string;
    checked_in_at: string;
    ticket_type?: string;
    ticket_id?: string;
    attendee_id?: string;
}

export default function ScanPage() {
    const searchParams = useSearchParams();
    const terminalId = searchParams.get('terminalId') || '904f9bad-9949-41ee-9221-067aed7630ee';
    const terminalName = searchParams.get('terminalName') || 'Gate Phone'; // Optional: allow passing name via URL, fallback to default

    const [activeTab, setActiveTab] = useState<'scan' | 'attendees'>('scan');
    const [status, setStatus] = useState<'ready' | 'scanning' | 'success' | 'error' | 'busy'>('ready');
    const [message, setMessage] = useState<string>('Ready to scan');
    const [lastResult, setLastResult] = useState<any>(null);
    const [history, setHistory] = useState<Array<{ code: string; time: string; ok: boolean; msg?: string }>>([]);
    const [scannerVisible, setScannerVisible] = useState(false);
    const [attendees, setAttendees] = useState<Attendee[]>([]);
    const [selectedAttendee, setSelectedAttendee] = useState<Attendee | null>(null);
    const [loadingAttendees, setLoadingAttendees] = useState(false);
    const [manualCode, setManualCode] = useState('');
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [realtimeConnected, setRealtimeConnected] = useState(false);

    const processingRef = useRef<Set<string>>(new Set());
    const lastSeenRef = useRef<Map<string, number>>(new Map());
    const supabaseRef = useRef<any>(null);

    // Initialize Supabase client
    useEffect(() => {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseAnonKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && supabaseAnonKey) {
            supabaseRef.current = createClient(supabaseUrl, supabaseAnonKey);
        } else {
            console.warn('Supabase credentials not found, realtime updates disabled');
        }
    }, []);

    // Set up Supabase realtime subscription
    useEffect(() => {
        if (activeTab !== 'attendees') return;

        fetchAttendees();

        let channel: any = null;

        if (supabaseRef.current) {
            channel = supabaseRef.current
                .channel('checkins')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'checkin_log', filter: `terminal_id=eq.${terminalId}` },
                    (payload: any) => {
                        console.log('Realtime update:', payload);
                        fetchAttendees();
                    }
                )
                .subscribe((status: string) => {
                    if (status === 'SUBSCRIBED') {
                        setRealtimeConnected(true);
                        console.log('Supabase realtime connected');
                    } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                        setRealtimeConnected(false);
                        console.log('Supabase realtime disconnected');
                    }
                });
        }

        return () => {
            if (channel) {
                supabaseRef.current?.removeChannel(channel);
                setRealtimeConnected(false);
            }
        };
    }, [activeTab, terminalId]); // Added terminalId dependency

    // Also refresh attendees list when a successful check-in happens
    useEffect(() => {
        if (status === 'success' && activeTab === 'attendees') {
            // Wait a bit to ensure backend is updated
            setTimeout(() => {
                fetchAttendees();
            }, 500);
        }
    }, [status, activeTab]);

    const fetchAttendees = async () => {
        // Don't show loading spinner for background refreshes
        const isInitialLoad = attendees.length === 0;
        if (isInitialLoad) setLoadingAttendees(true);

        try {
            const res = await fetch(`/api/attendees?terminalId=${terminalId}`);
            const data = await res.json();
            if (res.ok && data.attendees) {
                setAttendees(data.attendees);
            }
        } catch (err) {
            console.error('Failed to fetch attendees:', err);
        } finally {
            if (isInitialLoad) setLoadingAttendees(false);
        }
    };

    const copyToClipboard = async (text: string, field: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(field);
            setTimeout(() => setCopiedField(null), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleScan = async (detectedCodes: { rawValue: string }[]) => {
        if (detectedCodes.length === 0) return;

        let code = detectedCodes[0].rawValue;
        try {
            const url = new URL(code, window.location.href);
            const maybe = url.searchParams.get('code');
            if (maybe) code = maybe;
        } catch { }

        const now = Date.now();
        const last = lastSeenRef.current.get(code) ?? 0;
        if (now - last < 1300) return;
        lastSeenRef.current.set(code, now);

        if (processingRef.current.has(code)) return;
        processingRef.current.add(code);

        setStatus('busy');
        setMessage('Checking in...');

        try {
            const res = await fetch('/api/checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketCode: code, terminalId: terminalId }),
            });
            const data = await res.json();
            setLastResult(data);

            const ok = res.ok && data.ok;

            setHistory((h) => [
                {
                    code,
                    time: new Date().toISOString(),
                    ok,
                    msg: data?.message ?? data?.error ?? '',
                },
                ...h,
            ].slice(0, 20));

            if (ok) {
                try {
                    navigator.vibrate?.(200);
                } catch { }
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
                {
                    code,
                    time: new Date().toISOString(),
                    ok: false,
                    msg: 'network error',
                },
                ...h,
            ].slice(0, 20));
        } finally {
            processingRef.current.delete(code);
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
                body: JSON.stringify({ ticketCode: code, terminalId: terminalId }),
            });
            const data = await res.json();
            setLastResult(data);

            const ok = res.ok && data.ok;

            setHistory((h) => [
                {
                    code,
                    time: new Date().toISOString(),
                    ok,
                    msg: data?.message ?? '',
                },
                ...h,
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

    const handleManualSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        manualCheck(manualCode);
        setManualCode('');
    };

    if (!terminalId) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                <div className="text-red-600 font-semibold">Error: terminalId is required in the URL query parameters.</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="bg-white border-b sticky top-0 z-10">
                    <div className="p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h1 className="text-2xl font-bold text-slate-900">Quick Check-in</h1>
                            <div className="text-xs text-slate-500">
                                Terminal: <span className="font-semibold text-slate-700">{terminalName}</span>
                            </div>
                        </div>
                        {/* Tabs */}
                        <div className="flex gap-2 border-b -mb-px">
                            <button
                                onClick={() => setActiveTab('scan')}
                                className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${activeTab === 'scan'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-slate-600 hover:text-slate-900'
                                    }`}
                            >
                                <Scan className="inline-block w-4 h-4 mr-2" />
                                Scanner
                            </button>
                            <button
                                onClick={() => setActiveTab('attendees')}
                                className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${activeTab === 'attendees'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-slate-600 hover:text-slate-900'
                                    }`}
                            >
                                <Users className="inline-block w-4 h-4 mr-2" />
                                Attendees ({attendees.length})
                            </button>
                        </div>
                    </div>
                </div>

                {/* Tab Content */}
                <div className="p-4">
                    {activeTab === 'scan' ? (
                        <div className="space-y-4">
                            {/* Scanner Card */}
                            <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
                                <div className="p-4 border-b flex items-center justify-between">
                                    <h2 className="font-semibold text-slate-900">QR Scanner</h2>
                                    <div
                                        className={`px-3 py-1 rounded-full text-xs font-semibold ${status === 'success'
                                            ? 'bg-green-200 text-green-800'
                                            : status === 'error'
                                                ? 'bg-red-200 text-red-800'
                                                : status === 'scanning'
                                                    ? 'bg-blue-200 text-blue-800'
                                                    : status === 'busy'
                                                        ? 'bg-yellow-200 text-yellow-800'
                                                        : 'bg-slate-200 text-slate-700'
                                            }`}
                                    >
                                        {status === 'scanning'
                                            ? 'Scanning'
                                            : status === 'busy'
                                                ? 'Working...'
                                                : status === 'success'
                                                    ? 'Success'
                                                    : status === 'error'
                                                        ? 'Error'
                                                        : 'Ready'}
                                    </div>
                                </div>
                                <div className="p-4 space-y-4">
                                    <button
                                        onClick={toggleScanner}
                                        className={`w-full px-6 py-3 rounded-lg font-semibold text-white transition-colors flex items-center justify-center ${scannerVisible ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                                            }`}
                                    >
                                        {scannerVisible ? (
                                            <>
                                                <X className="mr-2 h-5 w-5" />
                                                Stop Scanner
                                            </>
                                        ) : (
                                            <>
                                                <Scan className="mr-2 h-5 w-5" />
                                                Start Scanner
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
                                    <div
                                        className={`p-4 rounded-lg flex items-center gap-3 ${status === 'success'
                                            ? 'bg-green-100 border border-green-300'
                                            : status === 'error'
                                                ? 'bg-red-100 border border-red-300'
                                                : status === 'busy'
                                                    ? 'bg-yellow-100 border border-yellow-300'
                                                    : 'bg-slate-100 border border-slate-300'
                                            }`}
                                    >
                                        {status === 'success' && <Check className="h-5 w-5 text-green-600 flex-shrink-0" />}
                                        {status === 'error' && <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />}
                                        {status === 'busy' && <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0" />}
                                        <span className="text-sm font-medium">{message}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Manual Entry Card */}
                            <div className="bg-white rounded-lg shadow-sm border">
                                <div className="p-4 border-b">
                                    <h3 className="font-semibold text-slate-900">Manual Entry</h3>
                                </div>
                                <div className="p-4">
                                    <form onSubmit={handleManualSubmit} className="flex gap-2">
                                        <input
                                            id="manual"
                                            value={manualCode}
                                            onChange={(e) => setManualCode(e.target.value)}
                                            className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            placeholder="Paste or type ticket code"
                                        />
                                        <button
                                            type="submit"
                                            className="px-6 py-3 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 transition-colors"
                                        >
                                            Check In
                                        </button>
                                    </form>
                                </div>
                            </div>

                            {/* Recent Scans Card */}
                            <div className="bg-white rounded-lg shadow-sm border">
                                <div className="p-4 border-b flex items-center justify-between">
                                    <h3 className="font-semibold text-slate-900">Recent Scans</h3>
                                    <button
                                        onClick={() => {
                                            setHistory([]);
                                            setLastResult(null);
                                        }}
                                        className="text-sm text-slate-600 hover:text-slate-900 font-medium"
                                    >
                                        Clear
                                    </button>
                                </div>
                                <div className="divide-y max-h-96 overflow-auto">
                                    {history.length === 0 ? (
                                        <div className="text-sm text-slate-400 text-center py-8">No recent scans</div>
                                    ) : (
                                        history.map((h, i) => (
                                            <div key={i} className="p-4 hover:bg-slate-50 transition-colors">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-mono text-sm font-medium text-slate-900 truncate">{h.code}</div>
                                                        <div className="text-xs text-slate-500 mt-1">{new Date(h.time).toLocaleString()}</div>
                                                    </div>
                                                    <div
                                                        className={`px-2 py-1 rounded text-xs font-bold whitespace-nowrap ${h.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                                            }`}
                                                    >
                                                        {h.ok ? '✓ Success' : h.msg || 'Failed'}
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Attendees List */}
                            <div className="bg-white rounded-lg shadow-sm border">
                                <div className="p-4 border-b flex items-center justify-between">
                                    <h2 className="font-semibold text-slate-900">Checked-in Attendees</h2>
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-2">
                                            <div
                                                className={`w-2 h-2 rounded-full ${realtimeConnected ? 'bg-green-500' : 'bg-red-500'
                                                    }`}
                                            />
                                            <span className="text-xs text-slate-500">
                                                {realtimeConnected ? 'Live' : 'Offline'}
                                            </span>
                                        </div>
                                        <button
                                            onClick={fetchAttendees}
                                            disabled={loadingAttendees}
                                            className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                                        >
                                            {loadingAttendees ? 'Refreshing...' : 'Refresh'}
                                        </button>
                                    </div>
                                </div>
                                <div className="divide-y max-h-[calc(100vh-200px)] overflow-auto">
                                    {loadingAttendees ? (
                                        <div className="text-center py-8 text-slate-500">Loading attendees...</div>
                                    ) : attendees.length === 0 ? (
                                        <div className="text-center py-8 text-slate-400">No checked-in attendees yet</div>
                                    ) : (
                                        attendees.map((attendee) => (
                                            <button
                                                key={attendee.id}
                                                onClick={() => setSelectedAttendee(attendee)}
                                                className="w-full p-4 hover:bg-slate-50 transition-colors text-left"
                                            >
                                                <div className="flex items-center justify-between">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-semibold text-slate-900 truncate">{attendee.name}</div>
                                                        <div className="text-sm text-slate-500 truncate">{attendee.email}</div>
                                                        <div className="text-xs text-slate-400 mt-1">
                                                            {new Date(attendee.checked_in_at).toLocaleString()}
                                                        </div>
                                                    </div>
                                                    <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 ml-3" />
                                                </div>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Attendee Modal */}
            {selectedAttendee && (
                <div
                    className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-50 p-4"
                    onClick={() => setSelectedAttendee(null)}
                >
                    <div
                        className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[90vh] overflow-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6 border-b sticky top-0 bg-white">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-bold text-slate-900">Attendee Details</h3>
                                <button
                                    onClick={() => setSelectedAttendee(null)}
                                    className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Name</label>
                                <div className="mt-1 flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-lg">
                                    <span className="text-sm font-medium text-slate-900">{selectedAttendee.name}</span>
                                    <button
                                        onClick={() => copyToClipboard(selectedAttendee.name, 'name')}
                                        className="p-1 hover:bg-slate-200 rounded transition-colors"
                                    >
                                        {copiedField === 'name' ? (
                                            <Check className="h-4 w-4 text-green-600" />
                                        ) : (
                                            <Copy className="h-4 w-4 text-slate-600" />
                                        )}
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Email</label>
                                <div className="mt-1 flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-lg">
                                    <span className="text-sm text-slate-900 truncate">{selectedAttendee.email}</span>
                                    <button
                                        onClick={() => copyToClipboard(selectedAttendee.email, 'email')}
                                        className="p-1 hover:bg-slate-200 rounded transition-colors flex-shrink-0"
                                    >
                                        {copiedField === 'email' ? (
                                            <Check className="h-4 w-4 text-green-600" />
                                        ) : (
                                            <Copy className="h-4 w-4 text-slate-600" />
                                        )}
                                    </button>
                                </div>
                            </div>
                            {selectedAttendee.phone && (
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Phone</label>
                                    <div className="mt-1 flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-lg">
                                        <span className="text-sm text-slate-900">{selectedAttendee.phone}</span>
                                        <button
                                            onClick={() => copyToClipboard(selectedAttendee.phone!, 'phone')}
                                            className="p-1 hover:bg-slate-200 rounded transition-colors"
                                        >
                                            {copiedField === 'phone' ? (
                                                <Check className="h-4 w-4 text-green-600" />
                                            ) : (
                                                <Copy className="h-4 w-4 text-slate-600" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            )}
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Ticket Code</label>
                                <div className="mt-1 flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-lg">
                                    <span className="text-sm font-mono text-slate-900">{selectedAttendee.ticket_code}</span>
                                    <button
                                        onClick={() => copyToClipboard(selectedAttendee.ticket_code, 'ticket')}
                                        className="p-1 hover:bg-slate-200 rounded transition-colors"
                                    >
                                        {copiedField === 'ticket' ? (
                                            <Check className="h-4 w-4 text-green-600" />
                                        ) : (
                                            <Copy className="h-4 w-4 text-slate-600" />
                                        )}
                                    </button>
                                </div>
                            </div>
                            {selectedAttendee.ticket_type && (
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Ticket Type</label>
                                    <div className="mt-1 p-3 bg-slate-50 rounded-lg">
                                        <span className="text-sm text-slate-900">{selectedAttendee.ticket_type}</span>
                                    </div>
                                </div>
                            )}
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Checked In At</label>
                                <div className="mt-1 p-3 bg-slate-50 rounded-lg">
                                    <span className="text-sm text-slate-900">
                                        {new Date(selectedAttendee.checked_in_at).toLocaleString()}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div className="p-6 border-t">
                            <button
                                onClick={() => setSelectedAttendee(null)}
                                className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800 transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}