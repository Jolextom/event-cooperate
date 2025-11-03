// lib/printService.ts
import { supabaseAdmin } from "./supabaseAdmin";

/**
 * Uploads a base64 PDF to Supabase Storage and enqueues a print_jobs row.
 * Returns the inserted print_job row.
 */
export async function uploadPdfAndEnqueuePrint(
  eventId: string,
  ticketCode: string,
  pdfBase64: string,
  ticketId: string | null,
  requestedBy = "system"
) {
  const filePath = `tickets/${eventId}/${ticketCode}.pdf`;
  const buffer = Buffer.from(pdfBase64, "base64");

  // upload to storage (bucket 'tickets')
  const { error: uploadErr } = await supabaseAdmin.storage
    .from("tickets")
    .upload(filePath, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadErr) {
    // bubble up for caller to handle or log
    throw uploadErr;
  }

  // merge pdfPath into ticket.meta if ticketId provided
  if (ticketId) {
    const { data: ticketRow, error: fetchErr } = await supabaseAdmin
      .from("tickets")
      .select("id, meta")
      .eq("id", ticketId)
      .maybeSingle();
    if (!fetchErr && ticketRow) {
      const currentMeta = ticketRow.meta ?? {};
      const newMeta = { ...currentMeta, pdfPath: filePath };
      const { error: updErr } = await supabaseAdmin
        .from("tickets")
        .update({ meta: newMeta })
        .eq("id", ticketId);
      if (updErr) console.warn("Could not update ticket meta", updErr);
    } else if (fetchErr) {
      console.warn("Could not fetch ticket to update meta", fetchErr);
    }
  } else {
    // fallback update by ticket_code (best effort)
    const { error: updErr } = await supabaseAdmin
      .from("tickets")
      .update({ meta: { pdfPath: filePath } })
      .eq("ticket_code", ticketCode);
    if (updErr) console.warn("Could not update ticket meta by code", updErr);
  }

  // insert print job; make sure print_jobs.file_path column exists
  const { data: pj, error: pjErr } = await supabaseAdmin
    .from("print_jobs")
    .insert([
      {
        ticket_id: ticketId,
        file_path: filePath,
        status: "pending",
        requested_by: requestedBy,
        created_at: new Date().toISOString(),
      },
    ])
    .select()
    .maybeSingle();

  if (pjErr) {
    throw pjErr;
  }
  return pj;
}
