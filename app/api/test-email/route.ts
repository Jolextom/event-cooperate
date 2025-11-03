// app/api/test-email/route.ts
import { NextResponse } from "next/server";
import { sendTicketEmail } from "@/lib/emailService";

export async function POST() {
  const to = "jolextom@gmail.com";
  const html = `<p>Test email from app — ${new Date().toISOString()}</p>`;
  const attachments = [
    {
      filename: "hello.txt",
      type: "text/plain",
      base64: Buffer.from("hello world").toString("base64"),
    },
  ];

  try {
    const result = await sendTicketEmail(to, "Test Email", html, attachments);
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    console.error("test-email error", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
