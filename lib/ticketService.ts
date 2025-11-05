// lib/ticketService.ts
import QRCode from "qrcode";
import { supabaseAdmin } from "./supabaseAdmin";
import { sendTicketEmail } from "./emailService";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function makeTicketCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Convert a PNG (data:) dataURL to Buffer */
function dataUrlToBuffer(dataUrl: string) {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid data URL");
  return Buffer.from(matches[2], "base64");
}

type GenerateOptions = {
  ticketCode: string;
  attendeeName?: string | null;
  eventName?: string | null;
  qrDataUrl: string;
  paperWidthMm?: number;
  paperHeightMm?: number;
  marginMm?: number;
};

// Generate PDF for EMAIL attachment (with name + role/company)
export async function generateTicketPdfBase64(options: GenerateOptions) {
  const {
    attendeeName,
    eventName,
    qrDataUrl,
    paperWidthMm = 60,
    paperHeightMm = 40,
    marginMm = 3,
  } = options;

  const pointsPerMm = 2.83465;
  const pageWidth = paperWidthMm * pointsPerMm;
  const pageHeight = paperHeightMm * pointsPerMm;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const margin = marginMm * pointsPerMm;
  const contentWidth = pageWidth - margin * 2;
  const contentLeft = margin;
  const contentTop = pageHeight - margin;

  const pngBytes = dataUrlToBuffer(qrDataUrl);
  const pngImage = await pdfDoc.embedPng(pngBytes);

  const qrSize = Math.min(contentWidth * 0.35, pageHeight * 0.7);
  const leftColumnX = contentLeft;
  const leftColumnWidth = contentWidth - qrSize - 4 * pointsPerMm;
  const rightColumnX = pageWidth - margin - qrSize;

  let currentY = contentTop;

  // Full Name - LARGER and title case
  if (attendeeName) {
    const formattedName = attendeeName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");

    page.drawText(formattedName, {
      x: leftColumnX,
      y: currentY,
      size: 11,
      font: fontBold,
      color: rgb(0, 0, 0),
      maxWidth: leftColumnWidth,
    });
    currentY -= 14;
  }

  // Role/Company - smaller below name
  if (eventName) {
    page.drawText(eventName, {
      x: leftColumnX,
      y: currentY,
      size: 8,
      font: fontNormal,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: leftColumnWidth,
    });
  }

  // Draw QR image on the right, vertically centered
  const qrY = (pageHeight - qrSize) / 2;
  page.drawImage(pngImage, {
    x: rightColumnX,
    y: qrY,
    width: qrSize,
    height: qrSize,
  });

  // Optional: thin border around QR
  page.drawRectangle({
    x: rightColumnX - 1,
    y: qrY - 1,
    width: qrSize + 2,
    height: qrSize + 2,
    borderWidth: 0.3,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.7, 0.7, 0.7),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString("base64");
}

export async function uploadTicketQRCode(ticketId: string) {
  const qrDataUrl = await QRCode.toDataURL(ticketId);
  const base64Data = qrDataUrl.split(",")[1];
  const buffer = Buffer.from(base64Data, "base64");

  const { error: uploadError } = await supabaseAdmin.storage
    .from("event-assets")
    .upload(`qrcodes/${ticketId}.png`, buffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (uploadError) throw new Error(uploadError.message);

  const { data } = await supabaseAdmin.storage
    .from("event-assets")
    .createSignedUrl(`qrcodes/${ticketId}.png`, 60 * 60 * 24 * 365 * 10);

  console.log("Signed URL data:", data);
  return data?.signedUrl;
}

export async function findTicketByAttendee(attendeeId: string) {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .select("id, ticket_code, meta")
    .eq("attendee_id", attendeeId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertTicket(
  att: any,
  ticketCode: string,
  qrDataUrl: string
) {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .insert([
      {
        event_id: att.event_id,
        attendee_id: att.id,
        ticket_code: ticketCode,
        qr_payload: ticketCode,
        meta: { qrDataUrl, importedMeta: att.meta ?? {} },
      },
    ])
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertEmailJob(
  ticketId: string | null,
  recipient: string,
  subject: string,
  body: string
) {
  const { data, error } = await supabaseAdmin
    .from("email_jobs")
    .insert([
      {
        ticket_id: ticketId,
        recipient,
        subject,
        body,
        status: "pending",
      },
    ])
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Build and send ticket for a single attendee record.
 * Returns { ok, attendeeId, ticketCode, error? }
 */
export async function buildAndSendTicketForAttendee(
  att: any,
  forceResend = false
) {
  // Skip if no email
  if (!att || !att.email) {
    console.log(`[ticketService] Skipping attendee ${att?.id} - no email`);
    return { ok: false, reason: "no-email", attendeeId: att?.id };
  }

  function escapeHtml(str: string) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toTitleCase(s: string) {
    return String(s || "")
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Get full name in title case, fallback to "Hi"
  const fullName = att.name ? toTitleCase(att.name.trim()) : "";
  const greeting = fullName ? escapeHtml(fullName) : "";

  // 1) Find existing ticket
  const existing = await findTicketByAttendee(att.id);
  if (existing && !forceResend) {
    return {
      ok: false,
      reason: "ticket_exists",
      attendeeId: att.id,
      ticketCode: existing.ticket_code,
    };
  }

  // 2) Ticket code + QR (data URL for PDF)
  const ticketCode = existing?.ticket_code ?? makeTicketCode();
  const qrDataUrl = await QRCode.toDataURL(ticketCode, {
    width: 400,
    margin: 1,
  });

  // 3) Insert or update ticket record
  let insertedTicket = existing ?? null;
  if (!existing) {
    insertedTicket = await insertTicket(att, ticketCode, qrDataUrl);
  } else if (forceResend) {
    const newMeta = { ...(existing.meta ?? {}), qrDataUrl };
    await supabaseAdmin
      .from("tickets")
      .update({ meta: newMeta })
      .eq("id", existing.id);
  }

  // 4) Generate EMAIL PDF attachment
  let emailPdfBase64: string | null = null;
  try {
    emailPdfBase64 = await generateTicketPdfBase64({
      ticketCode,
      attendeeName: att.name ?? null,
      eventName: att.company ?? att.title ?? att.role ?? "Attendee",
      qrDataUrl,
    });
    console.log("[ticketService] Email PDF generated successfully");
  } catch (e) {
    console.error("[ticketService] Email PDF generation failed", e);
    emailPdfBase64 = null;
  }

  // 5) Upload QR to Supabase Storage and get public URL
  const qrPublicUrl = await uploadTicketQRCode(ticketCode);
  console.log("[ticketService] QR public URL:", qrPublicUrl);

  // 6) Prepare email HTML
  const publicUrl = process.env.PUBLIC_URL ?? "";
  const bannerUrl = `${publicUrl}/banner.jpg`;
  const statusDisplay = att.status
    ? escapeHtml(String(att.status))
    : "Registered";

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
    </head>
    <body style="margin:0;padding:0;font-family: Arial, Helvetica, sans-serif;background-color:#f4f6f7;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:0 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(7,20,11,0.08);">
              <!-- Banner -->
              <tr>
                <td style="padding:0;">
                  <img src="${bannerUrl}" alt="Event banner" style="display:block;width:100%;height:auto;" />
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:28px 36px;color:#0b2a1a;">
                  <p style="margin:0 0 16px;font-size:14px;color:#222;">Hi${
                    greeting ? " " + greeting : ""
                  },</p>

                  <p style="margin:0 0 18px;font-size:15px;color:#333;">
                    We are pleased to confirm your participation in the <strong>8th Annual Convention on Impact Investing</strong>, hosted by the Impact Investors Foundation.
                  </p>

                  <p style="margin:0 0 18px;font-size:15px;color:#333;">
                    To ensure a smooth and efficient check-in, we have provided your unique QR code below. You only need to present one version at the registration desk.
                  </p>

                  <p style="margin:18px 0;text-align:center;">
                    <img src="${qrPublicUrl}" alt="Ticket QR Code" style="max-width:300px;width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />
                  </p>

                  <h3 style="font-size:15px;margin:16px 0 8px;color:#0b2a1a;">Event Details:</h3>
                  <ul style="margin:0 0 12px 18px;color:#333;font-size:14px;">
                    <li><strong>Event:</strong> 8th Annual Convention on Impact Investing</li>
                    <li><strong>Hosted By:</strong> Impact Investors Foundation</li>
                    <li><strong>Date:</strong> 5th - 6th November 2025</li>
                    <li><strong>Venue:</strong> Civic Centre, Lagos</li>
                    <li><strong>Time:</strong> 8am</li>
                    <li><strong>Status:</strong> ${statusDisplay}</li>
                  </ul>

                  <p style="margin:12px 0 0;color:#333;font-size:14px;">
                    If you have any questions or encounter issues viewing your QR code, please contact our team at <a href="mailto:events@swatleadershipacademy.com" style="color:#0b6b3a;text-decoration:none;">events@swatleadershipacademy.com</a>.
                  </p>

                  <p style="margin:8px 0 6px;font-size:13px;color:#555;">
                    For your convenience, your check-in pass (containing the same QR code) is also attached to this email as a PDF. You can save this file or print it.
                  </p>

                  <div style="margin-top:22px;color:#444;font-size:13px;">
                    <p style="margin:0;">We look forward to welcoming you.</p>
                    <p style="margin-top:18px;">Best regards,<br/>SWAT Events<br/>Registrations Management for the Impact Investors Foundation</p>
                  </div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background:#f7f9f7;padding:14px 36px;color:#6b756f;font-size:12px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;">
                    <div>&copy; ${new Date().getFullYear()} Impact Investors Foundation</div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  // 7) Create email job record
  const emailJob = await upsertEmailJob(
    insertedTicket?.id ?? null,
    att.email,
    `Check-In Pass: 8th Annual Convention on Impact Investing`,
    html
  );

  // 8) Prepare attachments: EMAIL PDF (base64 string for Resend)
  // 8) Prepare attachments: EMAIL PDF (base64 string for Resend)
  const attachments: any[] = [];
  if (emailPdfBase64) {
    attachments.push({
      filename: `${fullName || ticketCode}-CheckInPass.pdf`,
      content: Buffer.from(emailPdfBase64, "base64"),
    });
  }
  // 9) Send email including PDF attachment
  try {
    const sendResult = await sendTicketEmail(
      att.email,
      `Check-In Pass: 8th Annual Convention on Impact Investing`,
      html
      // attachments
    );

    console.log(`[ticketService] sendResult for ${att.email}:`, sendResult);

    if (sendResult.ok) {
      const sendResp = sendResult.resp;
      if (emailJob?.id) {
        await supabaseAdmin
          .from("email_jobs")
          .update({
            status: "sent",
            external_id: (sendResp as any)?.id ?? JSON.stringify(sendResp),
            updated_at: new Date().toISOString(),
          })
          .eq("id", emailJob.id);
      }
      return { ok: true, attendeeId: att.id, ticketCode, sendResp };
    } else {
      const errMsg = sendResult.error ?? "unknown";
      console.error("[ticketService] send failed:", errMsg, sendResult.raw);
      if (emailJob?.id) {
        await supabaseAdmin
          .from("email_jobs")
          .update({
            status: "failed",
            attempt_count: (emailJob.attempt_count ?? 0) + 1,
            last_error: errMsg,
            updated_at: new Date().toISOString(),
          })
          .eq("id", emailJob.id);
      }
      return {
        ok: false,
        reason: "email_failed",
        attendeeId: att.id,
        error: errMsg,
      };
    }
  } catch (err: any) {
    const errMsg = String(err?.message ?? err);
    console.error("[ticketService] send exception", errMsg);
    if (emailJob?.id) {
      await supabaseAdmin
        .from("email_jobs")
        .update({
          status: "failed",
          attempt_count: (emailJob.attempt_count ?? 0) + 1,
          last_error: errMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", emailJob.id);
    }
    return {
      ok: false,
      reason: "email_failed",
      attendeeId: att.id,
      error: errMsg,
    };
  }
}

/**
 * Batch send tickets with concurrency control
 * Optimized for sending 300+ tickets
 */
export async function batchSendTickets(
  attendees: any[],
  options: {
    forceResend?: boolean;
    concurrency?: number;
    onProgress?: (current: number, total: number, result: any) => void;
  } = {}
) {
  const { forceResend = false, concurrency = 10, onProgress } = options;
  const results: any[] = [];
  const total = attendees.length;

  // Process in batches with concurrency control
  for (let i = 0; i < attendees.length; i += concurrency) {
    const batch = attendees.slice(i, i + concurrency);
    const batchPromises = batch.map((att) =>
      buildAndSendTicketForAttendee(att, forceResend).catch((err) => ({
        ok: false,
        reason: "exception",
        attendeeId: att?.id,
        error: String(err?.message ?? err),
      }))
    );

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Report progress
    if (onProgress) {
      batchResults.forEach((result, idx) => {
        onProgress(i + idx + 1, total, result);
      });
    }

    // Small delay between batches to avoid overwhelming email service
    if (i + concurrency < attendees.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    total,
    successful: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
