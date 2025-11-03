import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const bodySchema = z.object({
  ticketCode: z.string().min(1),
  terminalId: z.string().optional(),
  actorId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return NextResponse.json(
        { ok: false, error: parsed.error.format() },
        { status: 400 }
      );

    const { ticketCode, terminalId, actorId } = parsed.data;

    const { data, error } = await supabaseAdmin.rpc("fn_checkin_ticket", {
      p_code: ticketCode,
      p_terminal: terminalId ?? "web",
      p_actor: actorId ?? null,
    });

    if (error) {
      console.error("fn_checkin_ticket error", error);
      return NextResponse.json({ ok: false, error }, { status: 500 });
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return NextResponse.json(
        { ok: false, message: "Not found or already checked" },
        { status: 404 }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({ ok: true, ticket: row });
  } catch (err: any) {
    console.error("checkin route error", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
