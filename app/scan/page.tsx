// app/scan/page.tsx
'use client';
import { useEffect, useState } from 'react';

export default function ScanPage() {
    const [status, setStatus] = useState<string | null>('Ready');
    const [lastResult, setLastResult] = useState<any>(null);

    useEffect(() => {
        let scanner: any = null;
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/html5-qrcode';
        script.async = true;
        script.onload = async () => {
            try {
                const Html5Qrcode = (window as any).Html5Qrcode;
                if (!Html5Qrcode) {
                    setStatus('Scanner library not available');
                    return;
                }
                const devices = await Html5Qrcode.getCameras();
                const cameraId = devices && devices.length ? devices[0].id : null;
                scanner = new Html5Qrcode('reader');
                await scanner.start(
                    cameraId,
                    { fps: 10, qrbox: 250 },
                    async (decodedText: string) => {
                        let code = decodedText;
                        try {
                            const url = new URL(decodedText, window.location.href);
                            const maybe = url.searchParams.get('code');
                            if (maybe) code = maybe;
                        } catch {
                            // not a URL — treat decodedText as code
                        }
                        setStatus('Checking in...');
                        try {
                            const res = await fetch('/api/checkin', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ticketCode: code, terminalId: 'gate-phone-1' })
                            });
                            const data = await res.json();
                            setLastResult(data);
                            if (res.ok && data.ok) {
                                setStatus('Checked in ✅ ' + (data.ticket?.ticket_code ?? ''));
                            } else {
                                setStatus('Error: ' + (data.message ?? JSON.stringify(data)));
                            }
                        } catch (err) {
                            setStatus('Network error during check-in');
                        }
                    },
                    (errorMessage: any) => {
                        // ignore per-frame errors
                    }
                );
            } catch (e) {
                console.error('Scanner init error', e);
                setStatus('Scanner init error');
            }
        };
        document.body.appendChild(script);

        return () => {
            if (scanner) scanner.stop().catch(() => { });
            script.remove();
        };
    }, []);

    return (
        <div style={{ padding: 12 }}>
            <h2>Scan ticket</h2>
            <div id="reader" style={{ width: '100%', maxWidth: 420, margin: '0 auto' }} />
            <div style={{ marginTop: 12 }}>
                <div><strong>Status:</strong> {status}</div>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{lastResult ? JSON.stringify(lastResult, null, 2) : ''}</pre>
            </div>
        </div>
    );
}
