// lib/emailService.ts
import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";

if (!RESEND_API_KEY) {
  console.error("Warning: RESEND_API_KEY not set");
}
if (!FROM_EMAIL) {
  console.error("Warning: FROM_EMAIL not set");
}

const resendClient = new Resend(RESEND_API_KEY);

/**
 * attachments: array of { filename: string, type: string, base64: string }
 * Resend expects attachment objects with { filename, type, content } where `content` is base64 string.
 */
export async function sendTicketEmail(
  to: string,
  subject: string,
  html: string,
  attachments?: { filename: string; type: string; base64: string }[]
) {
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    throw new Error("Missing email config (RESEND_API_KEY or FROM_EMAIL)");
  }

  // Map to Resend's expected shape: content (base64)
  const formattedAttachments =
    attachments?.map((a) => ({
      filename: a.filename,
      type: a.type,
      content: a.base64, // <- use `content` (base64) as required by Resend
    })) ?? [];

  const payload: any = {
    from: "SWAT Events <events@swatleadershipacademy.com>",
    to,
    subject,
    html,
  };
  if (formattedAttachments.length) payload.attachments = formattedAttachments;

  console.log("[emailService] sending email payload:", {
    to,
    subject,
    attachmentsCount: formattedAttachments.length,
  });

  try {
    const resp = await resendClient.emails.send(payload);
    console.log("[emailService] resend response:", resp.data);
    return { ok: true, resp };
  } catch (err: any) {
    console.error("[emailService] resend error:", err);
    return { ok: false, error: String(err?.message ?? err), raw: err };
  }
}
